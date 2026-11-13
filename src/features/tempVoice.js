/**
 * Section H, temporary voice channels (docs/ZIGBOT_FEATURE_MATRIX.md).
 * Off until a server switches it on (feature_settings.voice). Music and
 * the existing voice features are not touched.
 *
 *   join the "Join to create" channel -> ZiGBoT makes "<name>'s channel"
 *     next to it, moves the member in and makes them its owner;
 *   the last person leaves             -> the channel is deleted;
 *   /tempvoice lock|unlock|limit|rename|permit|reject|claim -> the owner's
 *     controls (permissions on that one channel only).
 *
 * Temp channels are remembered (kind "temp_voice"), and a sweep on the
 * shared scheduler deletes empty ones, so nothing is left behind after a
 * restart. Each member owns at most one, each server at most 50.
 */
const { PermissionFlagsBits, ChannelType } = require('discord.js');
const { sectionOf, safeText, botCan, reply, makeAudit } = require('./common');

const MAX_PER_GUILD = 50;
const CREATE_COOLDOWN_MS = 10_000;

function createTempVoice({ store, scheduler, resolveContext, auditLog, getClient = () => null, now = () => Date.now(), logger = console }) {
    const audit = makeAudit({ auditLog, logger, event: 'TEMP_VOICE' });
    const lastCreate = new Map();
    const fail = (what, error) => logger.error?.(`[ZiGBoT TEMP VOICE] ${what} failed: ${error?.code || error?.message || error}`);

    async function ctxFor(guild) {
        const context = await resolveContext(guild);
        if (context?.config?.enabled === false) return null;
        return { settings: context?.settings || {}, v: sectionOf(context?.config, 'voice') };
    }

    const humans = (channel) => [...(channel?.members?.values?.() || [])].filter((m) => !m.user?.bot).length;

    async function removeIfEmpty(guild, channelId, settings) {
        const record = await store.get(guild.id, 'temp_voice', channelId);
        if (!record) return false;
        const channel = guild.channels?.cache?.get?.(channelId);
        if (channel && humans(channel) > 0) return false;
        if (channel) {
            const ok = await channel.delete('Temporary voice channel is empty').then(() => true, (error) => { fail('delete', error); return false; });
            if (!ok) return false;
        }
        await store.remove(guild.id, 'temp_voice', channelId);
        await audit({ guild, id: record.data.ownerId }, settings, { action: 'tempvoice_delete', target: channelId });
        return true;
    }

    async function create(member, v, settings) {
        const guild = member.guild;
        const hub = guild.channels?.cache?.get?.(v.tempvoice_hub_channel_id);
        if (!hub) return;
        if (!botCan(guild, PermissionFlagsBits.ManageChannels) || !botCan(guild, PermissionFlagsBits.MoveMembers)) {
            await audit({ guild, id: member.id }, settings, { action: 'tempvoice_create', result: 'SKIPPED', details: { reason: 'needs Manage Channels and Move Members' } });
            return;
        }
        // Already owns one: go there instead of making another.
        const owned = (await store.list(guild.id, 'temp_voice', { limit: MAX_PER_GUILD + 1 }));
        const mine = owned.find((r) => r.data.ownerId === member.id && guild.channels?.cache?.has?.(r.key));
        if (mine) {
            await member.voice.setChannel(mine.key, 'Back to their temporary voice channel').catch((error) => fail('move', error));
            return;
        }
        if (owned.length >= MAX_PER_GUILD) return;
        const t = now();
        if (t - (lastCreate.get(member.id) || 0) < CREATE_COOLDOWN_MS) return; // hub-hopping cannot spam channels
        lastCreate.set(member.id, t);

        const name = safeText(v.tempvoice_name.replaceAll('{user}', member.displayName || member.user?.username || 'Member'), 100).replace(/@​/g, '') || 'Voice';
        const channel = await guild.channels.create({
            name,
            type: ChannelType.GuildVoice,
            parent: v.tempvoice_category_id || hub.parentId || undefined,
            userLimit: v.tempvoice_limit || undefined,
            permissionOverwrites: [{ id: member.id, allow: [PermissionFlagsBits.ManageChannels, PermissionFlagsBits.MoveMembers, PermissionFlagsBits.Connect] }],
            reason: `Temporary voice channel for ${member.id}`
        }).catch((error) => { fail('create', error); return null; });
        if (!channel) return;
        await store.put(guild.id, 'temp_voice', channel.id, { ownerId: member.id, createdAt: t });
        await member.voice.setChannel(channel, 'Temporary voice channel').catch((error) => fail('move', error));
        await audit({ guild, id: member.id }, settings, { action: 'tempvoice_create', target: channel.id });
    }

    /** From the existing VoiceStateUpdate listener. Never throws. */
    async function onVoiceState(oldState, newState) {
        try {
            const guild = newState?.guild || oldState?.guild;
            const member = newState?.member || oldState?.member;
            if (!guild || !member || member.user?.bot) return;
            if (oldState?.channelId === newState?.channelId) return; // mute, deafen, stream: not a move
            const ctx = await ctxFor(guild);
            if (!ctx?.v.tempvoice_enabled || !ctx.v.tempvoice_hub_channel_id) return;
            if (oldState?.channelId) await removeIfEmpty(guild, oldState.channelId, ctx.settings);
            if (newState?.channelId === ctx.v.tempvoice_hub_channel_id) await create(member, ctx.v, ctx.settings);
        } catch (error) {
            fail('voice state', error);
        }
    }

    // After a restart, nobody "leaves" the channels that emptied meanwhile.
    async function sweep() {
        for (const guild of getClient()?.guilds?.cache?.values?.() || []) {
            try {
                const ctx = await ctxFor(guild);
                if (!ctx) continue;
                for (const record of await store.list(guild.id, 'temp_voice', { limit: MAX_PER_GUILD })) await removeIfEmpty(guild, record.key, ctx.settings);
            } catch (error) {
                fail('sweep', error);
            }
        }
    }
    let lastSweep = 0;
    scheduler.every(async (t) => {
        if (t - lastSweep < 5 * 60_000) return;
        lastSweep = t;
        await sweep();
    });

    // ---------------------------------------------------------- /tempvoice
    async function handleSlash(interaction) {
        try {
            const guild = interaction.guild;
            if (!guild) return reply(interaction, '❌ This only works inside a server.');
            const ctx = await ctxFor(guild);
            if (!ctx?.v.tempvoice_enabled) return reply(interaction, '❌ Temporary voice channels are switched off in this server.');
            const channel = interaction.member?.voice?.channel;
            const record = channel ? await store.get(guild.id, 'temp_voice', channel.id) : null;
            if (!record) return reply(interaction, '❌ Join your temporary voice channel first.');
            const sub = interaction.options.getSubcommand();
            const userId = interaction.user.id;

            if (sub === 'claim') {
                if (record.data.ownerId === userId) return reply(interaction, 'You already own this channel.');
                if (channel.members?.has?.(record.data.ownerId)) return reply(interaction, '❌ The owner is still here.');
                await store.put(guild.id, 'temp_voice', channel.id, { ...record.data, ownerId: userId });
                await channel.permissionOverwrites.delete(record.data.ownerId).catch(() => {});
                await channel.permissionOverwrites.edit(userId, { ManageChannels: true, MoveMembers: true, Connect: true });
                await audit(interaction, ctx.settings, { action: 'tempvoice_claim', target: channel.id });
                return reply(interaction, '✅ You own this channel now.');
            }
            if (record.data.ownerId !== userId) return reply(interaction, '❌ Only the channel owner can do that.');

            const everyone = guild.id;
            if (sub === 'lock' || sub === 'unlock') {
                await channel.permissionOverwrites.edit(everyone, { Connect: sub === 'lock' ? false : null });
            } else if (sub === 'limit') {
                const limit = interaction.options.getInteger('users');
                if (!Number.isInteger(limit) || limit < 0 || limit > 99) return reply(interaction, '❌ 0 to 99 (0 = no limit).');
                await channel.setUserLimit(limit);
            } else if (sub === 'rename') {
                const name = safeText(interaction.options.getString('name'), 100).replace(/@​/g, '').trim();
                if (!name) return reply(interaction, '❌ Give a name.');
                await channel.setName(name);
            } else if (sub === 'permit' || sub === 'reject') {
                const target = interaction.options.getUser('member');
                if (!target || target.id === userId) return reply(interaction, '❌ Pick another member.');
                await channel.permissionOverwrites.edit(target.id, { Connect: sub === 'permit' });
                if (sub === 'reject') {
                    const there = channel.members?.get?.(target.id);
                    if (there) await there.voice.disconnect('Removed from a temporary voice channel by its owner').catch(() => {});
                }
            } else {
                return reply(interaction, '❌ Unknown option.');
            }
            await audit(interaction, ctx.settings, { action: `tempvoice_${sub}`, target: channel.id });
            return reply(interaction, '✅ Done.');
        } catch (error) {
            fail('/tempvoice', error);
            return reply(interaction, '❌ I could not change the channel (I may be missing permissions). Nothing else was changed.').catch(() => {});
        }
    }

    return {
        onVoiceState,
        sweep,
        handlesSlash: (interaction) => interaction.commandName === 'tempvoice',
        handleSlash
    };
}

module.exports = { createTempVoice, MAX_PER_GUILD };
