/**
 * Section C, Community (docs/ZIGBOT_FEATURE_MATRIX.md). Every feature is
 * off until a server switches it on (feature_settings.community).
 *
 *   member joins   -> welcome message (+ image card), auto-role, milestone
 *   member leaves  -> goodbye message
 *   both           -> member-count voice channel name (max once / 10 min)
 *   reactions      -> starboard, reaction-role panels
 *   /roles         -> self-assign role panels (buttons, dropdown, reactions)
 *   /suggest       -> suggestion with votes and staff approve / deny
 *   /community     -> birthday, poll, announce, remind, stats
 *
 * Called from the EXISTING listeners in src/index.js. Nothing here throws:
 * Discord and storage failures are logged.
 */
const { PermissionFlagsBits, ChannelType } = require('discord.js');
const { NO_PINGS, sectionOf, safeText, botCan, memberCan, roleProblem, requesterOutranks, reply, makeAudit } = require('./common');

const PREFIX = 'zbc:';
const COUNT_INTERVAL_MS = 10 * 60_000;
const NUMBER_EMOJI = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣'];
const STAR = '⭐';
const MAX_PANELS = 25;
const MAX_REMINDER_MINUTES = 60 * 24 * 30;

/** {user} {server} {memberCount}: the only placeholders. */
function renderTemplate(template, { userId, guild }) {
    return safeText(String(template || '')
        .replaceAll('{user}', `<@${userId}>`)
        .replaceAll('{server}', safeText(guild.name, 100))
        .replaceAll('{memberCount}', String(guild.memberCount ?? '?')), 1900);
}

/** Today's { day, month, date } in a timezone ("Asia/Kolkata" by default). */
function localDate(nowMs, timeZone) {
    let parts;
    try {
        parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(nowMs));
    } catch {
        parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(nowMs));
    }
    const get = (type) => parts.find((p) => p.type === type).value;
    return { day: Number(get('day')), month: Number(get('month')), date: `${get('year')}-${get('month')}-${get('day')}` };
}

const validBirthday = (day, month) => Number.isInteger(day) && Number.isInteger(month) && month >= 1 && month <= 12
    && day >= 1 && day <= [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];

function createCommunity({ store, scheduler, resolveContext, auditLog, getClient = () => null, renderWelcomeImage = null, now = () => Date.now(), logger = console }) {
    const audit = makeAudit({ auditLog, logger, event: 'COMMUNITY' });
    const lastCountUpdate = new Map();
    const fail = (what, error) => logger.error?.(`[ZiGBoT COMMUNITY] ${what} failed: ${error?.code || error?.message || error}`);

    async function ctxFor(guild) {
        const context = await resolveContext(guild);
        if (context?.config?.enabled === false) return null; // server switched ZiGBoT off
        return { settings: context?.settings || {}, c: sectionOf(context?.config, 'community') };
    }

    async function textChannel(guild, id) {
        if (!id) return null;
        const channel = guild.channels?.cache?.get?.(id) || await guild.channels?.fetch?.(id).catch(() => null);
        return channel?.isTextBased?.() && String(channel.guildId || guild.id) === String(guild.id) ? channel : null;
    }

    // ------------------------------------------------------- joins / leaves
    async function updateMemberCount(guild, c) {
        if (!c.member_count_enabled || !c.member_count_channel_id) return;
        const t = now();
        if (t - (lastCountUpdate.get(guild.id) || 0) < COUNT_INTERVAL_MS) return;
        if (!botCan(guild, PermissionFlagsBits.ManageChannels)) return;
        const channel = guild.channels?.cache?.get?.(c.member_count_channel_id);
        if (!channel?.setName) return;
        const name = safeText(c.member_count_template.replaceAll('{count}', String(guild.memberCount ?? '?')), 100) || `Members: ${guild.memberCount}`;
        lastCountUpdate.set(guild.id, t);
        if (channel.name !== name) await channel.setName(name, 'Member count').catch((error) => fail('member count', error));
    }

    async function onMemberAdd(member) {
        try {
            const guild = member.guild;
            const ctx = await ctxFor(guild);
            if (!ctx) return;
            const { c, settings } = ctx;
            if (c.autorole_enabled && !member.user?.bot) {
                for (const roleId of c.autorole_role_ids) {
                    const role = guild.roles?.cache?.get?.(roleId);
                    const problem = roleProblem(guild, role);
                    if (problem) {
                        await audit(member, settings, { action: 'autorole', target: roleId, result: 'SKIPPED', details: { reason: problem } });
                        continue;
                    }
                    await member.roles.add(role, 'Auto-role').then(
                        () => audit(member, settings, { action: 'autorole', target: roleId }),
                        (error) => fail('auto-role', error)
                    );
                }
            }
            if (c.welcome_enabled) {
                const channel = await textChannel(guild, c.welcome_channel_id);
                if (channel) {
                    const payload = { content: renderTemplate(c.welcome_message, { userId: member.id, guild }), allowedMentions: { parse: [], users: [member.id] } };
                    if (c.welcome_image_enabled && renderWelcomeImage) {
                        const png = await Promise.resolve().then(() => renderWelcomeImage({ name: member.displayName || member.user?.username || 'New member', server: guild.name, memberCount: guild.memberCount })).catch((error) => { fail('welcome image', error); return null; });
                        if (png) payload.files = [{ attachment: png, name: 'welcome.png' }];
                    }
                    await channel.send(payload).catch((error) => fail('welcome', error));
                }
            }
            if (c.milestones_enabled && guild.memberCount > 0 && guild.memberCount % c.milestone_every === 0) {
                const channel = await textChannel(guild, c.welcome_channel_id);
                // One post per milestone, even if someone leaves and rejoins at the same count.
                if (channel && await store.create(guild.id, 'milestone', String(guild.memberCount), { at: now() })) {
                    await channel.send({ content: `🎉 **${safeText(guild.name, 100)}** just reached **${guild.memberCount} members**!`, allowedMentions: NO_PINGS }).catch((error) => fail('milestone', error));
                }
            }
            await updateMemberCount(guild, c);
        } catch (error) {
            fail('member join', error);
        }
    }

    async function onMemberRemove(member) {
        try {
            const guild = member.guild;
            const ctx = await ctxFor(guild);
            if (!ctx) return;
            const { c } = ctx;
            if (c.goodbye_enabled) {
                const channel = await textChannel(guild, c.goodbye_channel_id);
                // A goodbye names the member but never pings someone who has left.
                if (channel) await channel.send({ content: renderTemplate(c.goodbye_message, { userId: member.id, guild }), allowedMentions: NO_PINGS }).catch((error) => fail('goodbye', error));
            }
            await updateMemberCount(guild, c);
        } catch (error) {
            fail('member leave', error);
        }
    }

    // ------------------------------------------------------------ reactions
    async function toggleRole(guild, member, roleId, want) {
        const role = guild.roles?.cache?.get?.(roleId);
        const problem = roleProblem(guild, role);
        if (problem) return { error: problem };
        const hasRole = Boolean(member.roles?.cache?.has?.(roleId));
        const add = want === null ? !hasRole : want;
        if (add === hasRole) return { added: hasRole, role, unchanged: true };
        if (add) await member.roles.add(role, 'Self-assigned role');
        else await member.roles.remove(role, 'Self-assigned role');
        return { added: add, role };
    }

    async function onReaction(reaction, user, added) {
        try {
            if (!user || user.bot) return;
            if (reaction.partial) await reaction.fetch();
            const message = reaction.message?.partial ? await reaction.message.fetch() : reaction.message;
            const guild = message?.guild;
            if (!guild) return;
            const ctx = await ctxFor(guild);
            if (!ctx) return;
            const { c, settings } = ctx;
            const emoji = reaction.emoji?.name;

            if (c.role_panels_enabled && NUMBER_EMOJI.includes(emoji)) {
                const panel = await store.get(guild.id, 'role_panel', message.id);
                const roleId = panel?.data?.type === 'reactions' ? panel.data.roles[NUMBER_EMOJI.indexOf(emoji)] : null;
                if (roleId) {
                    const member = guild.members?.cache?.get?.(user.id) || await guild.members.fetch(user.id).catch(() => null);
                    if (!member) return;
                    const result = await toggleRole(guild, member, roleId, added);
                    await audit({ guild, user }, settings, { action: added ? 'role_panel_add' : 'role_panel_remove', target: roleId, result: result.error ? 'DENIED' : 'SUCCESS', details: result.error ? { reason: result.error } : {} });
                    return;
                }
            }

            if (added && c.starboard_enabled && emoji === STAR && c.starboard_channel_id && message.channelId !== c.starboard_channel_id) {
                if (message.author?.bot) return;
                const users = await reaction.users.fetch();
                const stars = [...users.values()].filter((u) => !u.bot && u.id !== message.author?.id).length;
                if (stars < c.starboard_threshold) return;
                const board = await textChannel(guild, c.starboard_channel_id);
                if (!board) return;
                // create() is the lock: a message is posted to the starboard once, ever.
                if (!await store.create(guild.id, 'star', message.id, { at: now() })) return;
                const image = message.attachments?.find?.((a) => String(a.contentType || '').startsWith('image/'));
                await board.send({
                    content: `${STAR} **${stars}** · <#${message.channelId}> · by <@${message.author.id}>\n${safeText(message.content, 1500)}\n${message.url}`,
                    files: image ? [image.url] : [],
                    allowedMentions: NO_PINGS
                }).catch((error) => fail('starboard', error));
            }
        } catch (error) {
            fail('reaction', error);
        }
    }

    // ---------------------------------------------------------------- /roles
    async function rolesPanel(interaction, guild, c, settings) {
        if (!c.role_panels_enabled) return reply(interaction, '❌ Role panels are switched off. An admin can enable them in the ZiGBoT dashboard (Features → Community).');
        if (!memberCan(interaction.member, PermissionFlagsBits.ManageRoles)) {
            await audit(interaction, settings, { action: 'role_panel_create', result: 'DENIED', details: { reason: 'missing Manage Roles' } });
            return reply(interaction, '❌ You need the Manage Roles permission.');
        }
        const type = interaction.options.getString('type');
        const title = safeText(interaction.options.getString('title') || 'Pick your roles', 200);
        const picked = [];
        for (let i = 1; i <= 5; i += 1) {
            const role = interaction.options.getRole(`role${i}`);
            if (role && !picked.some((r) => r.id === role.id)) picked.push(role);
        }
        for (const role of picked) {
            const problem = roleProblem(guild, guild.roles?.cache?.get?.(role.id) || role)
                || (requesterOutranks(guild, interaction.member, role) ? null : `${role.name} is at or above your own highest role.`);
            if (problem) {
                await audit(interaction, settings, { action: 'role_panel_create', target: role.id, result: 'DENIED', details: { reason: problem } });
                return reply(interaction, `❌ ${role.name}: ${problem}`);
            }
        }
        if ((await store.list(guild.id, 'role_panel', { limit: MAX_PANELS + 1 })).length >= MAX_PANELS) return reply(interaction, `❌ This server already has ${MAX_PANELS} role panels.`);

        const ids = picked.map((r) => r.id);
        const lines = picked.map((r, i) => `${type === 'reactions' ? `${NUMBER_EMOJI[i]} ` : '• '}<@&${r.id}>`).join('\n');
        const payload = { content: `**${title}**\n${lines}`, allowedMentions: NO_PINGS };
        if (type === 'buttons') {
            payload.components = [{ type: 1, components: picked.map((r) => ({ type: 2, style: 2, label: r.name.slice(0, 80), custom_id: `${PREFIX}role:${r.id}` })) }];
        } else if (type === 'dropdown') {
            payload.components = [{ type: 1, components: [{ type: 3, custom_id: `${PREFIX}roles`, placeholder: 'Choose your roles', min_values: 0, max_values: picked.length, options: picked.map((r) => ({ label: r.name.slice(0, 100), value: r.id })) }] }];
        }
        const message = await interaction.channel.send(payload);
        await store.put(guild.id, 'role_panel', message.id, { type, roles: ids, channelId: interaction.channel.id, createdBy: interaction.user.id });
        if (type === 'reactions') for (let i = 0; i < ids.length; i += 1) await message.react(NUMBER_EMOJI[i]).catch((error) => fail('panel reaction', error));
        await audit(interaction, settings, { action: 'role_panel_create', target: message.id, details: { type, roles: ids.join(',') } });
        return reply(interaction, '✅ Role panel posted.');
    }

    async function panelComponent(interaction, guild, c, settings) {
        if (!c.role_panels_enabled) return reply(interaction, '❌ Role panels are switched off in this server.');
        const panel = await store.get(guild.id, 'role_panel', interaction.message.id);
        if (!panel) return reply(interaction, '❌ This role panel is no longer active.');
        const id = interaction.customId.slice(PREFIX.length);
        // Only roles stored for THIS panel count, whatever the button or menu claims.
        const wanted = id === 'roles' ? panel.data.roles.map((roleId) => [roleId, (interaction.values || []).includes(roleId)]) : [[id.slice('role:'.length), null]];
        const done = [];
        for (const [roleId, want] of wanted) {
            if (!panel.data.roles.includes(roleId)) return reply(interaction, '❌ That role is not part of this panel.');
            const result = await toggleRole(guild, interaction.member, roleId, want);
            if (result.error) {
                await audit(interaction, settings, { action: 'role_panel_toggle', target: roleId, result: 'DENIED', details: { reason: result.error } });
                return reply(interaction, `❌ ${result.error}`);
            }
            if (!result.unchanged) {
                done.push(`${result.added ? '➕' : '➖'} ${result.role.name}`);
                await audit(interaction, settings, { action: result.added ? 'role_panel_add' : 'role_panel_remove', target: roleId });
            }
        }
        return reply(interaction, done.length ? `✅ ${done.join(', ')}` : 'No changes.');
    }

    // -------------------------------------------------------------- /suggest
    const suggestionText = (d) => `💡 **Suggestion** by <@${d.authorId}>${d.status === 'open' ? '' : ` · **${d.status.toUpperCase()}** by <@${d.decidedBy}>`}\n${d.text}\n\n👍 ${d.up.length} · 👎 ${d.down.length}`;
    const suggestionButtons = (open) => (open ? [{ type: 1, components: [
        { type: 2, style: 3, label: 'Upvote', emoji: { name: '👍' }, custom_id: `${PREFIX}sv:up` },
        { type: 2, style: 4, label: 'Downvote', emoji: { name: '👎' }, custom_id: `${PREFIX}sv:down` },
        { type: 2, style: 2, label: 'Approve (staff)', custom_id: `${PREFIX}sd:approved` },
        { type: 2, style: 2, label: 'Deny (staff)', custom_id: `${PREFIX}sd:denied` }
    ] }] : []);

    async function suggest(interaction, guild, c, settings) {
        if (!c.suggestions_enabled) return reply(interaction, '❌ Suggestions are switched off in this server.');
        const channel = await textChannel(guild, c.suggestions_channel_id);
        if (!channel) return reply(interaction, '❌ The suggestions channel is missing. Ask an admin to pick one in the dashboard.');
        const text = safeText(interaction.options.getString('idea'), 1500).trim();
        if (!text) return reply(interaction, '❌ Write your suggestion.');
        const data = { authorId: interaction.user.id, text, up: [], down: [], status: 'open', decidedBy: null };
        const message = await channel.send({ content: suggestionText(data), components: suggestionButtons(true), allowedMentions: NO_PINGS });
        await store.put(guild.id, 'suggestion', message.id, data);
        await audit(interaction, settings, { action: 'suggest', target: message.id });
        return reply(interaction, `✅ Suggestion posted in <#${channel.id}>.`);
    }

    async function suggestionComponent(interaction, guild, settings) {
        const [kind, value] = interaction.customId.slice(PREFIX.length).split(':');
        const userId = interaction.user.id;
        if (kind === 'sd' && !memberCan(interaction.member, PermissionFlagsBits.ManageMessages)) {
            await audit(interaction, settings, { action: 'suggestion_decide', target: interaction.message.id, result: 'DENIED', details: { reason: 'missing Manage Messages' } });
            return reply(interaction, '❌ Only staff (Manage Messages) can approve or deny suggestions.');
        }
        let closed = false;
        const { record } = await store.mutate(guild.id, 'suggestion', interaction.message.id, (d) => {
            if (!d) return undefined;
            if (d.status !== 'open') { closed = true; return undefined; }
            if (kind === 'sv') {
                // One vote per member: voting again moves or removes it.
                const had = (value === 'up' ? d.up : d.down).includes(userId);
                d.up = d.up.filter((id) => id !== userId);
                d.down = d.down.filter((id) => id !== userId);
                if (!had) (value === 'up' ? d.up : d.down).push(userId);
            } else {
                d.status = value === 'approved' ? 'approved' : 'denied';
                d.decidedBy = userId;
            }
            return d;
        });
        if (!record) return reply(interaction, '❌ This suggestion is no longer tracked.');
        if (closed) return reply(interaction, 'This suggestion is already closed.');
        await interaction.message.edit({ content: suggestionText(record.data), components: suggestionButtons(record.data.status === 'open'), allowedMentions: NO_PINGS }).catch((error) => fail('suggestion edit', error));
        if (kind === 'sd') await audit(interaction, settings, { action: `suggestion_${record.data.status}`, target: interaction.message.id });
        return reply(interaction, kind === 'sv' ? '✅ Vote counted.' : `✅ Suggestion ${record.data.status}.`);
    }

    // ------------------------------------------------------------ /community
    async function birthdayPosts(t) {
        const client = getClient();
        for (const guild of client?.guilds?.cache?.values?.() || []) {
            try {
                const ctx = await ctxFor(guild);
                if (!ctx?.c.birthdays_enabled) continue;
                const today = localDate(t, ctx.c.timezone);
                // create() is the lock: one birthday post per server per local day.
                if (!await store.create(guild.id, 'birthday_post', today.date, { at: t })) continue;
                const mine = (await store.list(guild.id, 'birthday', { limit: 1000 })).filter((r) => r.data.day === today.day && r.data.month === today.month);
                const present = [];
                for (const r of mine) if (guild.members?.cache?.has?.(r.key) || await guild.members?.fetch?.(r.key).then(() => true, () => false)) present.push(r.key);
                if (!present.length) continue;
                const channel = await textChannel(guild, ctx.c.birthday_channel_id);
                if (channel) await channel.send({ content: `🎂 Happy birthday ${present.map((id) => `<@${id}>`).join(', ')}! 🎉`, allowedMentions: { parse: [], users: present.slice(0, 50) } });
            } catch (error) {
                fail('birthdays', error);
            }
        }
    }

    scheduler.register('reminder', async ({ guildId, payload }) => {
        const guild = getClient()?.guilds?.cache?.get?.(guildId);
        if (!guild) return;
        const ctx = await ctxFor(guild);
        if (!ctx?.c.announcements_enabled) return; // switched off since it was set
        const channel = await textChannel(guild, payload.channelId);
        if (channel) await channel.send({ content: `⏰ **Reminder:** ${safeText(payload.text, 1800)}`, allowedMentions: NO_PINGS });
    });
    scheduler.every(birthdayPosts);

    async function community(interaction, guild, c, settings) {
        const sub = interaction.options.getSubcommand();
        const staff = memberCan(interaction.member, PermissionFlagsBits.ManageMessages);
        const deny = async (reason) => {
            await audit(interaction, settings, { action: `community_${sub}`, result: 'DENIED', details: { reason } });
            return reply(interaction, `❌ ${reason}`);
        };
        if (sub === 'stats') {
            const channels = guild.channels?.cache;
            const count = (type) => (channels ? [...channels.values()].filter((ch) => ch.type === type).length : 0);
            const bots = guild.members?.cache ? [...guild.members.cache.values()].filter((m) => m.user?.bot).length : 0;
            return reply(interaction, [
                `📊 **${safeText(guild.name, 100)}**`,
                `Members: ${guild.memberCount ?? '?'} (bots seen: ${bots})`,
                `Text channels: ${count(ChannelType.GuildText)} · Voice channels: ${count(ChannelType.GuildVoice)}`,
                `Roles: ${guild.roles?.cache?.size ?? '?'} · Boosts: ${guild.premiumSubscriptionCount ?? 0}`
            ].join('\n'));
        }
        if (sub === 'birthday' || sub === 'birthday-remove') {
            if (!c.birthdays_enabled) return reply(interaction, '❌ Birthdays are switched off in this server.');
            if (sub === 'birthday-remove') {
                await store.remove(guild.id, 'birthday', interaction.user.id);
                return reply(interaction, '✅ Your birthday was removed.');
            }
            const day = interaction.options.getInteger('day');
            const month = interaction.options.getInteger('month');
            if (!validBirthday(day, month)) return reply(interaction, '❌ That is not a real date. Use a day and a month, for example day:14 month:2.');
            // Day and month only: no year, so no age is ever stored.
            await store.put(guild.id, 'birthday', interaction.user.id, { day, month });
            return reply(interaction, `✅ Saved: ${day}/${month}. I will wish you in <#${c.birthday_channel_id}>.`);
        }
        if (sub === 'poll') {
            if (!c.polls_enabled) return reply(interaction, '❌ Polls are switched off in this server.');
            if (!staff) return deny('Only staff (Manage Messages) can start polls.');
            const question = safeText(interaction.options.getString('question'), 300).trim();
            const answers = [...new Set(String(interaction.options.getString('options') || '').split('|').map((a) => safeText(a, 55).trim()).filter(Boolean))];
            if (!question || answers.length < 2 || answers.length > 10) return reply(interaction, '❌ Give a question and 2 to 10 options separated by | (for example: Pizza | Burger | Pasta).');
            const hours = Math.min(Math.max(interaction.options.getInteger('hours') || 24, 1), 168);
            // Discord's own polls: one vote per member is enforced by Discord.
            await interaction.channel.send({ poll: { question: { text: question }, answers: answers.map((text) => ({ text })), duration: hours, allowMultiselect: false }, allowedMentions: NO_PINGS });
            await audit(interaction, settings, { action: 'poll', target: interaction.channel.id, details: { options: answers.length, hours } });
            return reply(interaction, '✅ Poll posted.');
        }
        if (sub === 'announce' || sub === 'remind') {
            if (!c.announcements_enabled) return reply(interaction, '❌ Announcements and reminders are switched off in this server.');
            if (!staff) return deny('Only staff (Manage Messages) can do that.');
            const target = interaction.options.getChannel('channel') || interaction.channel;
            const channel = await textChannel(guild, target?.id);
            if (!channel) return reply(interaction, '❌ Pick a text channel in this server.');
            const text = safeText(interaction.options.getString('message'), 1800).trim();
            if (!text) return reply(interaction, '❌ Write the message.');
            if (sub === 'announce') {
                await channel.send({ content: `📢 ${text}`, allowedMentions: NO_PINGS });
                await audit(interaction, settings, { action: 'announce', target: channel.id });
                return reply(interaction, `✅ Announced in <#${channel.id}>.`);
            }
            const minutes = interaction.options.getInteger('minutes');
            if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_REMINDER_MINUTES) return reply(interaction, `❌ Minutes must be from 1 to ${MAX_REMINDER_MINUTES} (30 days).`);
            const dueAt = now() + minutes * 60_000;
            try {
                await scheduler.schedule(guild.id, 'reminder', { channelId: channel.id, text, by: interaction.user.id }, dueAt);
            } catch (error) {
                return reply(interaction, `❌ ${error.message}`);
            }
            await audit(interaction, settings, { action: 'remind', target: channel.id, details: { minutes } });
            return reply(interaction, `✅ Reminder set for <t:${Math.floor(dueAt / 1000)}:R> in <#${channel.id}>.`);
        }
        return reply(interaction, '❌ Unknown option.');
    }

    // ------------------------------------------------------------ dispatch
    async function run(interaction, fn) {
        try {
            const guild = interaction.guild;
            if (!guild) return reply(interaction, '❌ This only works inside a server.');
            const ctx = await ctxFor(guild);
            if (!ctx) return reply(interaction, '❌ ZiGBoT is switched off in this server by its admins.');
            return await fn(guild, ctx.c, ctx.settings);
        } catch (error) {
            fail(interaction.commandName || interaction.customId || 'interaction', error);
            return reply(interaction, '❌ Something went wrong. Nothing was changed.').catch(() => {});
        }
    }

    const COMMANDS = ['roles', 'suggest', 'community'];
    return {
        COMMANDS,
        onMemberAdd,
        onMemberRemove,
        onReaction,
        birthdayPosts,
        handlesSlash: (interaction) => COMMANDS.includes(interaction.commandName),
        handleSlash: (interaction) => run(interaction, (guild, c, settings) => {
            if (interaction.commandName === 'roles') return rolesPanel(interaction, guild, c, settings);
            if (interaction.commandName === 'suggest') return suggest(interaction, guild, c, settings);
            return community(interaction, guild, c, settings);
        }),
        isComponent: (interaction) => typeof interaction.customId === 'string' && interaction.customId.startsWith(PREFIX),
        handleComponent: (interaction) => run(interaction, (guild, c, settings) => (
            interaction.customId.startsWith(`${PREFIX}role`) ? panelComponent(interaction, guild, c, settings) : suggestionComponent(interaction, guild, settings)
        ))
    };
}

module.exports = { createCommunity, renderTemplate, localDate, validBirthday, NUMBER_EMOJI };
