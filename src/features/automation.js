/**
 * Section J, Automation (docs/ZIGBOT_FEATURE_MATRIX.md). Off until a server
 * switches it on (feature_settings.automation).
 *
 *   scheduled messages / auto-announcements  -> shared scheduler tick
 *   auto-purge                                -> shared scheduler tick
 *   rules: WHEN join|message|reaction IF role/channel THEN send/add role/remove role
 *   /automation remind | event-create | events | rules
 *
 * Interval work is claimed through a versioned record (kind "auto_run"), so
 * a restart or a second worker never double-posts or double-purges.
 * Custom commands reuse Section E (src/utilities/customCommands.js) and
 * auto-role reuses Section C: nothing is duplicated here.
 */
const crypto = require('node:crypto');
const { PermissionFlagsBits, GuildScheduledEventEntityType, GuildScheduledEventPrivacyLevel } = require('discord.js');
const { NO_PINGS, sectionOf, safeText, botCan, memberCan, roleProblem, reply, makeAudit } = require('./common');
const { renderTemplate } = require('./community');

const HOUR = 3_600_000;
const DAY14 = 14 * 24 * HOUR - 60_000; // Discord bulk-delete limit, with a minute of margin
const RULE_COOLDOWN_MS = 10_000;
const MAX_PERSONAL_REMINDERS = 10;
const MAX_REMINDER_MINUTES = 60 * 24 * 30;

const itemKey = (type, entry) => `${type}:${crypto.createHash('sha256').update(JSON.stringify(entry)).digest('hex').slice(0, 24)}`;

function createAutomation({ store, scheduler, resolveContext, auditLog, getClient = () => null, now = () => Date.now(), logger = console }) {
    const audit = makeAudit({ auditLog, logger, event: 'AUTOMATION' });
    const ruleCooldown = new Map();
    const fail = (what, error) => logger.error?.(`[ZiGBoT AUTOMATION] ${what} failed: ${error?.code || error?.message || error}`);

    async function ctxFor(guild) {
        const context = await resolveContext(guild);
        if (context?.config?.enabled === false) return null;
        return { settings: context?.settings || {}, a: sectionOf(context?.config, 'automation') };
    }

    async function textChannel(guild, id) {
        if (!id) return null;
        const channel = guild.channels?.cache?.get?.(id) || await guild.channels?.fetch?.(id).catch(() => null);
        return channel?.isTextBased?.() && String(channel.guildId || guild.id) === String(guild.id) ? channel : null;
    }

    /** true once per interval for this entry, across restarts and workers. */
    async function claimInterval(guildId, key, everyMs, t) {
        let claimed = false;
        await store.mutate(guildId, 'auto_run', key, (data) => {
            if (data && t - data.last < everyMs) return undefined;
            claimed = true;
            return { last: t };
        });
        return claimed;
    }

    // ---------------------------------------------------- interval work
    async function runScheduled(guild, a, settings, t) {
        if (a.scheduled_messages_enabled) {
            for (const entry of a.scheduled_messages) {
                if (!await claimInterval(guild.id, itemKey('msg', entry), entry.every_hours * HOUR, t)) continue;
                const channel = await textChannel(guild, entry.channel_id);
                if (!channel) continue;
                const content = safeText(String(entry.message).replaceAll('{server}', safeText(guild.name, 100)).replaceAll('{memberCount}', String(guild.memberCount ?? '?')), 1900);
                await channel.send({ content, allowedMentions: NO_PINGS }).then(
                    () => audit({ guild, id: 'system' }, settings, { action: 'scheduled_message', target: channel.id }),
                    (error) => fail('scheduled message', error)
                );
            }
        }
        if (a.auto_purge_enabled) {
            for (const entry of a.auto_purge) {
                if (!await claimInterval(guild.id, itemKey('purge', entry), entry.every_hours * HOUR, t)) continue;
                const channel = await textChannel(guild, entry.channel_id);
                if (!channel?.bulkDelete || !botCan(guild, PermissionFlagsBits.ManageMessages)) {
                    await audit({ guild, id: 'system' }, settings, { action: 'auto_purge', target: entry.channel_id, result: 'SKIPPED', details: { reason: 'channel missing or no Manage Messages' } });
                    continue;
                }
                const cutoff = t - entry.older_than_hours * HOUR;
                const messages = await channel.messages.fetch({ limit: 100 }).catch((error) => { fail('purge fetch', error); return null; });
                if (!messages) continue;
                const old = [...messages.values()].filter((m) => !m.pinned && m.createdTimestamp < cutoff && m.createdTimestamp > t - DAY14);
                if (!old.length) continue;
                const deleted = await channel.bulkDelete(old.map((m) => m.id), true).catch((error) => { fail('purge', error); return null; });
                await audit({ guild, id: 'system' }, settings, { action: 'auto_purge', target: channel.id, result: deleted ? 'SUCCESS' : 'FAILED', details: { deleted: deleted?.size ?? 0 } });
            }
        }
    }

    async function tick(t) {
        for (const guild of getClient()?.guilds?.cache?.values?.() || []) {
            try {
                const ctx = await ctxFor(guild);
                if (ctx && (ctx.a.scheduled_messages_enabled || ctx.a.auto_purge_enabled)) await runScheduled(guild, ctx.a, ctx.settings, t);
            } catch (error) {
                fail('tick', error);
            }
        }
    }
    scheduler.every(tick);

    // ------------------------------------------------------------- rules
    async function applyRule(rule, index, { guild, member, channel, settings }) {
        if (rule.if_role_id && !member.roles?.cache?.has?.(rule.if_role_id)) return;
        if (rule.if_channel_id && channel?.id !== rule.if_channel_id && channel?.parentId !== rule.if_channel_id) return;
        // A rule fires at most once per 10 s per channel: rules cannot be used to flood.
        const key = `${guild.id}:${index}:${channel?.id || 'none'}`;
        const t = now();
        if (t - (ruleCooldown.get(key) || 0) < RULE_COOLDOWN_MS) return;
        ruleCooldown.set(key, t);
        if (ruleCooldown.size > 5000) ruleCooldown.clear();

        if (rule.then === 'send_message') {
            const target = rule.channel_id ? await textChannel(guild, rule.channel_id) : channel;
            if (!target?.send) return;
            await target.send({ content: renderTemplate(rule.message, { userId: member.id, guild }), allowedMentions: { parse: [], users: [member.id] } })
                .then(() => audit({ guild, id: member.id }, settings, { action: 'rule_send', target: target.id, details: { rule: index + 1, when: rule.when } }), (error) => fail('rule send', error));
            return;
        }
        const role = guild.roles?.cache?.get?.(rule.role_id);
        const problem = roleProblem(guild, role);
        if (problem) {
            await audit({ guild, id: member.id }, settings, { action: `rule_${rule.then}`, target: rule.role_id, result: 'DENIED', details: { rule: index + 1, reason: problem } });
            return;
        }
        const has = member.roles?.cache?.has?.(role.id);
        if ((rule.then === 'add_role') === Boolean(has)) return;
        await (rule.then === 'add_role' ? member.roles.add(role, 'Automation rule') : member.roles.remove(role, 'Automation rule'))
            .then(() => audit({ guild, id: member.id }, settings, { action: `rule_${rule.then}`, target: role.id, details: { rule: index + 1, when: rule.when } }), (error) => fail('rule role', error));
    }

    async function runRules(guild, member, when, match, channel) {
        if (!member || member.user?.bot) return;
        const ctx = await ctxFor(guild);
        if (!ctx?.a.rules_enabled) return;
        for (const [index, rule] of ctx.a.rules.entries()) {
            if (rule.when !== when || !match(rule)) continue;
            await applyRule(rule, index, { guild, member, channel, settings: ctx.settings }).catch((error) => fail('rule', error));
        }
    }

    const onMemberAdd = (member) => runRules(member.guild, member, 'join', () => true, null).catch((error) => fail('join rules', error));

    async function onMessage(message) {
        if (!message?.guild || message.author?.bot || message.webhookId || message.system) return false;
        const text = String(message.content || '').toLowerCase();
        await runRules(message.guild, message.member, 'message', (rule) => text.includes(rule.keyword.trim().toLowerCase()), message.channel).catch((error) => fail('message rules', error));
        return false; // rules never stop the normal bot flow
    }

    async function onReaction(reaction, user, added) {
        if (!added || !user || user.bot) return;
        try {
            const message = reaction.message?.partial ? await reaction.message.fetch() : reaction.message;
            const guild = message?.guild;
            if (!guild) return;
            const member = guild.members?.cache?.get?.(user.id) || await guild.members.fetch(user.id).catch(() => null);
            const emoji = reaction.emoji?.name || '';
            await runRules(guild, member, 'reaction', (rule) => rule.emoji.trim() === emoji || rule.emoji.trim() === reaction.emoji?.toString?.(), message.channel);
        } catch (error) {
            fail('reaction rules', error);
        }
    }

    // ------------------------------------------------------- /automation
    scheduler.register('personal_reminder', async ({ guildId, payload }) => {
        const guild = getClient()?.guilds?.cache?.get?.(guildId);
        if (!guild) return;
        const ctx = await ctxFor(guild);
        if (!ctx?.a.reminders_enabled) return;
        const channel = await textChannel(guild, payload.channelId);
        // Pings only the member who asked for it.
        if (channel) await channel.send({ content: `⏰ <@${payload.userId}>, reminder: ${safeText(payload.text, 1800)}`, allowedMentions: { parse: [], users: [payload.userId] } });
    });

    async function handleSlash(interaction) {
        try {
            const guild = interaction.guild;
            if (!guild) return reply(interaction, '❌ This only works inside a server.');
            const ctx = await ctxFor(guild);
            if (!ctx) return reply(interaction, '❌ ZiGBoT is switched off in this server by its admins.');
            const { a, settings } = ctx;
            const sub = interaction.options.getSubcommand();
            const deny = async (reason) => {
                await audit(interaction, settings, { action: `automation_${sub}`, result: 'DENIED', details: { reason } });
                return reply(interaction, `❌ ${reason}`);
            };

            if (sub === 'remind') {
                if (!a.reminders_enabled) return reply(interaction, '❌ Personal reminders are switched off in this server.');
                const minutes = interaction.options.getInteger('minutes');
                const text = safeText(interaction.options.getString('message'), 1800).trim();
                if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_REMINDER_MINUTES) return reply(interaction, `❌ Minutes must be from 1 to ${MAX_REMINDER_MINUTES} (30 days).`);
                if (!text) return reply(interaction, '❌ Write what to remind you about.');
                const mine = (await scheduler.list(guild.id, 'personal_reminder')).filter((job) => job.data.payload.userId === interaction.user.id);
                if (mine.length >= MAX_PERSONAL_REMINDERS) return reply(interaction, `❌ You already have ${MAX_PERSONAL_REMINDERS} reminders waiting.`);
                const dueAt = now() + minutes * 60_000;
                await scheduler.schedule(guild.id, 'personal_reminder', { userId: interaction.user.id, channelId: interaction.channel.id, text }, dueAt);
                return reply(interaction, `✅ I will remind you here <t:${Math.floor(dueAt / 1000)}:R>.`);
            }
            if (sub === 'event-create') {
                if (!a.events_enabled) return reply(interaction, '❌ Scheduled events are switched off in this server.');
                if (!memberCan(interaction.member, PermissionFlagsBits.ManageEvents)) return deny('You need the Manage Events permission.');
                if (!botCan(guild, PermissionFlagsBits.ManageEvents)) return deny('I need the Manage Events permission.');
                const inMinutes = interaction.options.getInteger('starts_in_minutes');
                const duration = interaction.options.getInteger('duration_minutes') || 60;
                if (!Number.isInteger(inMinutes) || inMinutes < 1 || inMinutes > 60 * 24 * 365) return reply(interaction, '❌ The start must be 1 minute to 1 year from now.');
                const start = now() + inMinutes * 60_000;
                const event = await guild.scheduledEvents.create({
                    name: safeText(interaction.options.getString('name'), 100),
                    description: safeText(interaction.options.getString('description') || '', 1000) || undefined,
                    scheduledStartTime: new Date(start),
                    scheduledEndTime: new Date(start + duration * 60_000),
                    privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly,
                    entityType: GuildScheduledEventEntityType.External,
                    entityMetadata: { location: safeText(interaction.options.getString('location') || 'Discord', 100) }
                });
                await audit(interaction, settings, { action: 'event_create', target: event.id });
                return reply(interaction, `✅ Event **${safeText(event.name, 100)}** created for <t:${Math.floor(start / 1000)}:F>.`);
            }
            if (sub === 'events') {
                if (!a.events_enabled) return reply(interaction, '❌ Scheduled events are switched off in this server.');
                const events = await guild.scheduledEvents.fetch();
                const list = [...events.values()].slice(0, 10).map((e) => `• **${safeText(e.name, 100)}** <t:${Math.floor(e.scheduledStartTimestamp / 1000)}:R>${e.userCount != null ? ` · ${e.userCount} interested` : ''}`);
                return reply(interaction, list.length ? `📅 Upcoming events\n${list.join('\n')}` : 'No scheduled events.');
            }
            if (sub === 'rules') {
                if (!memberCan(interaction.member, PermissionFlagsBits.ManageGuild)) return deny('You need the Manage Server permission.');
                const rules = a.rules.map((r, i) => `${i + 1}. WHEN ${r.when}${r.keyword ? ` "${safeText(r.keyword, 50)}"` : ''}${r.emoji ? ` ${safeText(r.emoji, 20)}` : ''}${r.if_role_id ? ` IF role <@&${r.if_role_id}>` : ''}${r.if_channel_id ? ` IN <#${r.if_channel_id}>` : ''} THEN ${r.then.replace('_', ' ')}${r.role_id ? ` <@&${r.role_id}>` : ''}`);
                return reply(interaction, [`⚙️ Rules are **${a.rules_enabled ? 'on' : 'off'}** (edit them in the dashboard: Add-ons → Automation).`, ...rules].join('\n').slice(0, 1900) || 'No rules.');
            }
            return reply(interaction, '❌ Unknown option.');
        } catch (error) {
            fail('/automation', error);
            return reply(interaction, '❌ Something went wrong. Nothing was changed.').catch(() => {});
        }
    }

    return {
        onMemberAdd,
        onMessage,
        onReaction,
        tick,
        handlesSlash: (interaction) => interaction.commandName === 'automation',
        handleSlash
    };
}

module.exports = { createAutomation, itemKey };
