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
const {
    PermissionFlagsBits, ChannelType, ButtonStyle, ActionRowBuilder, ButtonBuilder,
    EmbedBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, UserSelectMenuBuilder
} = require('discord.js');
const { sectionOf, safeText, botCan, reply, makeAudit } = require('./common');

const MAX_PER_GUILD = 50;
const CREATE_COOLDOWN_MS = 10_000;
const PANEL_PREFIX = 'zbtv:';

function createTempVoice({ store, scheduler, resolveContext, auditLog, getClient = () => null, now = () => Date.now(), logger = console }) {
    const audit = makeAudit({ auditLog, logger, event: 'TEMP_VOICE' });
    const lastCreate = new Map();
    const creating = new Map();
    const fail = (what, error) => logger.error?.(`[ZiGBoT TEMP VOICE] ${what} failed: ${error?.code || error?.message || error}`);

    async function ctxFor(guild) {
        const context = await resolveContext(guild);
        if (context?.config?.enabled === false) return null;
        return { settings: context?.settings || {}, v: sectionOf(context?.config, 'voice') };
    }

    const humans = (channel) => [...(channel?.members?.values?.() || [])].filter((m) => !m.user?.bot).length;

    function panelEmbed(channel, record) {
        const data = record.data;
        return new EmbedBuilder().setColor(data.locked ? 0xe74c3c : 0x8b5cf6)
            .setTitle('🎮 VOICE CHANNEL CONTROL CENTER')
            .setDescription('Welcome to your personal voice channel!\n\nManage your channel, control access, invite friends and customize your experience using the controls below.')
            .addFields(
                { name: 'Channel', value: `<#${channel.id}>`, inline: true },
                { name: 'Owner', value: `<@${data.ownerId}>`, inline: true },
                { name: 'Members', value: `${channel.members?.size || 0}${channel.userLimit ? ` / ${channel.userLimit}` : ' (unlimited)'}`, inline: true },
                { name: 'Privacy', value: data.locked ? 'Private' : 'Public', inline: true },
                { name: 'Created', value: `<t:${Math.floor((data.createdAt || now()) / 1000)}:R>`, inline: true }
            ).setFooter({ text: 'Only the channel owner can use these controls.' });
    }

    const button = (action, label, style = ButtonStyle.Secondary, emoji = null, channelId = null) => {
        const b = new ButtonBuilder().setCustomId(`${PANEL_PREFIX}${action}:${channelId}`).setLabel(label).setStyle(style);
        if (emoji) b.setEmoji(emoji);
        return b;
    };

    function panelRows(channelId) {
        return [
            new ActionRowBuilder().addComponents(
                button('lock', 'Lock Channel', ButtonStyle.Secondary, '🔒', channelId),
                button('unlock', 'Unlock Channel', ButtonStyle.Secondary, '🔓', channelId),
                button('limit', 'Set User Limit', ButtonStyle.Secondary, '👥', channelId),
                button('rename', 'Rename Channel', ButtonStyle.Secondary, '✏️', channelId)
            ),
            new ActionRowBuilder().addComponents(
                button('invite', 'Invite Member', ButtonStyle.Primary, '➕', channelId),
                button('remove', 'Remove Member', ButtonStyle.Secondary, '➖', channelId),
                button('kick', 'Kick Member', ButtonStyle.Secondary, '🥾', channelId),
                button('members', 'View Members', ButtonStyle.Secondary, '📋', channelId)
            ),
            new ActionRowBuilder().addComponents(
                button('access', 'Toggle Voice Access', ButtonStyle.Secondary, '🎙️', channelId),
                button('mute', 'Toggle Channel Mute', ButtonStyle.Secondary, '🔇', channelId),
                button('refresh', 'Refresh Dashboard', ButtonStyle.Secondary, '🔄', channelId),
                button('delete', 'Delete Channel', ButtonStyle.Danger, '🗑️', channelId)
            )
        ];
    }

    async function updatePanel(channel, record) {
        if (!record.data.dashboardMessageId) return;
        const message = await channel.messages?.fetch?.(record.data.dashboardMessageId).catch(() => null);
        if (message) await message.edit({ embeds: [panelEmbed(channel, record)], components: panelRows(channel.id) }).catch((error) => fail('dashboard update', error));
    }

    async function postPanel(channel, record) {
        if (typeof channel.send !== 'function') return record;
        const message = await channel.send({ embeds: [panelEmbed(channel, record)], components: panelRows(channel.id) })
            .catch((error) => { fail('dashboard post', error); return null; });
        if (!message) return record;
        return store.put(channel.guild.id, 'temp_voice', channel.id, { ...record.data, dashboardMessageId: message.id });
    }

    async function getChannel(guild, channelId) {
        return guild?.channels?.cache?.get?.(channelId) || await guild?.channels?.fetch?.(channelId).catch(() => null);
    }

    async function panelError(interaction, message) {
        const payload = { content: message, ephemeral: true };
        if (interaction.deferred || interaction.replied) return interaction.followUp(payload);
        return interaction.reply(payload);
    }

    async function ownerRecord(interaction, channelId) {
        const guild = interaction.guild;
        if (!guild || interaction.channelId !== channelId && interaction.message?.channelId !== channelId) return { error: 'This dashboard does not belong to this channel.' };
        const record = await store.get(guild.id, 'temp_voice', channelId);
        const channel = await getChannel(guild, channelId);
        if (!record || !channel) return { error: 'This temporary channel no longer exists.' };
        if (record.data.ownerId !== interaction.user.id) return { error: 'Only the owner of this temporary voice channel can use these controls.' };
        return { guild, channel, record };
    }

    async function showUserPicker(interaction, action, channelId) {
        const menu = new UserSelectMenuBuilder().setCustomId(`${PANEL_PREFIX}select:${action}:${channelId}`)
            .setPlaceholder(action === 'invite' ? 'Choose a member to invite' : action === 'remove' ? 'Choose an invited member to remove' : 'Choose a member to kick')
            .setMinValues(1).setMaxValues(1);
        return interaction.reply({ content: 'Choose a server member:', components: [new ActionRowBuilder().addComponents(menu)], ephemeral: true });
    }

    async function handlePanelComponent(interaction) {
        const parts = interaction.customId.split(':');
        const action = parts[1] === 'select' ? parts[2] : parts[1];
        const channelId = parts.at(-1);
        const base = await ownerRecord(interaction, channelId);
        if (base.error) return panelError(interaction, `❌ ${base.error}`);
        const { guild, channel } = base;
        let record = base.record;

        if (interaction.isModalSubmit?.()) {
            if (action === 'limit') {
                const raw = interaction.fields.getTextInputValue('limit').trim();
                if (!/^\d{1,2}$/.test(raw) || Number(raw) > 99) return panelError(interaction, 'Enter a whole number from 0 to 99 (0 means unlimited).');
                await channel.setUserLimit(Number(raw));
                record = await store.put(guild.id, 'temp_voice', channelId, { ...record.data, userLimit: Number(raw) });
            } else if (action === 'rename') {
                const name = safeText(interaction.fields.getTextInputValue('name'), 100).replace(/@​/g, '').trim();
                if (!name) return panelError(interaction, 'Enter a channel name.');
                await channel.setName(name);
                record = await store.put(guild.id, 'temp_voice', channelId, { ...record.data, channelName: name });
            }
            await updatePanel(channel, record);
            return interaction.reply({ content: '✅ Channel updated.', ephemeral: true });
        }

        if (interaction.isUserSelectMenu?.()) {
            const selected = interaction.values[0];
            if (action === 'invite') {
                await channel.permissionOverwrites.edit(selected, { ViewChannel: true, Connect: true });
                record = await store.put(guild.id, 'temp_voice', channelId, { ...record.data, invited: [...new Set([...(record.data.invited || []), selected])] });
                await interaction.update({ content: `✅ <@${selected}> can join this channel.`, components: [] });
            } else if (action === 'remove') {
                if (!(record.data.invited || []).includes(selected)) return panelError(interaction, 'That member is not on this channel’s invite list.');
                await channel.permissionOverwrites.delete(selected).catch(() => channel.permissionOverwrites.edit(selected, { Connect: false }));
                record = await store.put(guild.id, 'temp_voice', channelId, { ...record.data, invited: record.data.invited.filter((id) => id !== selected) });
                await interaction.update({ content: `✅ <@${selected}> no longer has channel access.`, components: [] });
            } else if (action === 'kick') {
                const target = await guild.members.fetch(selected).catch(() => null);
                if (!target || selected === record.data.ownerId || target.permissions.has(PermissionFlagsBits.Administrator)) return panelError(interaction, 'The owner and server administrators cannot be kicked from this channel.');
                if (target.voice.channelId !== channelId) return panelError(interaction, 'That member is not in this channel.');
                if (!botCan(guild, PermissionFlagsBits.MoveMembers)) return panelError(interaction, 'I need the Move Members permission to disconnect that member.');
                await target.voice.disconnect('Removed by temporary channel owner');
                await interaction.update({ content: `✅ <@${selected}> was disconnected.`, components: [] });
            } else if (action === 'mute') {
                const target = await guild.members.fetch(selected).catch(() => null);
                if (!target || target.voice.channelId !== channelId) return panelError(interaction, 'Choose a member currently in this channel.');
                if (selected === record.data.ownerId || target.permissions.has(PermissionFlagsBits.Administrator)) return panelError(interaction, 'The owner and server administrators cannot be muted here.');
                if (!botCan(guild, PermissionFlagsBits.MuteMembers)) return panelError(interaction, 'I need the Mute Members permission to server-mute members.');
                if (!target.manageable) return panelError(interaction, 'Discord role hierarchy prevents me from muting that member.');
                const mute = !target.voice.serverMute;
                await target.voice.setMute(mute, 'Temporary channel owner control');
                await interaction.update({ content: `✅ ${mute ? 'Muted' : 'Unmuted'} <@${selected}>.`, components: [] });
            }
            record = await store.get(guild.id, 'temp_voice', channelId);
            await updatePanel(channel, record);
            return;
        }

        if (action === 'limit' || action === 'rename') {
            const input = new TextInputBuilder().setCustomId(action === 'limit' ? 'limit' : 'name')
                .setLabel(action === 'limit' ? 'User limit (0–99, 0 = unlimited)' : 'New channel name')
                .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(action === 'limit' ? 2 : 100)
                .setValue(action === 'limit' ? String(channel.userLimit || 0) : channel.name);
            const modal = new ModalBuilder().setCustomId(`${PANEL_PREFIX}${action}:${channelId}`).setTitle(action === 'limit' ? 'Set user limit' : 'Rename channel')
                .addComponents(new ActionRowBuilder().addComponents(input));
            await interaction.showModal(modal);
            return;
        }
        if (['invite', 'remove', 'kick', 'mute'].includes(action)) return showUserPicker(interaction, action, channelId);
        await interaction.deferReply({ ephemeral: true });
        if (action === 'members') {
            const members = [...channel.members.values()].map((m) => `• ${m.user.username}${m.id === record.data.ownerId ? ' (owner)' : ''}`).join('\n') || 'No members currently connected.';
            return interaction.editReply({ content: members.slice(0, 1900) });
        }
        if (action === 'delete') {
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`${PANEL_PREFIX}delete-yes:${channelId}`).setLabel('Delete channel').setStyle(ButtonStyle.Danger),
                new ButtonBuilder().setCustomId(`${PANEL_PREFIX}delete-no:${channelId}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary)
            );
            return interaction.editReply({ content: 'Delete this temporary voice channel? This cannot be undone.', components: [row] });
        }
        if (action === 'delete-no') return interaction.editReply({ content: 'Deletion cancelled.', components: [] });
        if (action === 'delete-yes') {
            await channel.delete('Temporary channel deleted by its owner');
            await store.remove(guild.id, 'temp_voice', channelId);
            return interaction.editReply({ content: '✅ Temporary channel deleted.', components: [] });
        }
        if (action === 'lock' || action === 'unlock' || action === 'access') {
            const locked = action === 'access' ? !record.data.locked : action === 'lock';
            await channel.permissionOverwrites.edit(guild.id, { Connect: locked ? false : null });
            record = await store.put(guild.id, 'temp_voice', channelId, { ...record.data, locked });
            await updatePanel(channel, record);
            return interaction.editReply({ content: locked ? '🔒 Channel locked. Invited members retain access.' : '🔓 Channel is public again.' });
        }
        if (action === 'refresh') {
            await updatePanel(channel, record);
            return interaction.editReply({ content: '🔄 Dashboard refreshed.' });
        }
    }

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

    async function createOnce(member, v, settings) {
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
        let record = await store.put(guild.id, 'temp_voice', channel.id, {
            ownerId: member.id, createdAt: t, dashboardMessageId: null, locked: false,
            userLimit: channel.userLimit || 0, channelName: channel.name, invited: []
        });
        await member.voice.setChannel(channel, 'Temporary voice channel').catch((error) => fail('move', error));
        record = await postPanel(channel, record);
        await audit({ guild, id: member.id }, settings, { action: 'tempvoice_create', target: channel.id });
    }

    async function create(member, v, settings) {
        const key = `${member.guild.id}:${member.id}`;
        if (creating.has(key)) return creating.get(key);
        const pending = createOnce(member, v, settings).finally(() => creating.delete(key));
        creating.set(key, pending);
        return pending;
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
                const claimed = await store.put(guild.id, 'temp_voice', channel.id, { ...record.data, ownerId: userId });
                await channel.permissionOverwrites.delete(record.data.ownerId).catch(() => {});
                await channel.permissionOverwrites.edit(userId, { ManageChannels: true, MoveMembers: true, Connect: true });
                await updatePanel(channel, claimed);
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
            await updatePanel(channel, await store.get(guild.id, 'temp_voice', channel.id));
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
        isComponent: (interaction) => typeof interaction.customId === 'string' && interaction.customId.startsWith(PANEL_PREFIX),
        handleComponent: handlePanelComponent,
        handlesSlash: (interaction) => interaction.commandName === 'tempvoice',
        handleSlash
    };
}

module.exports = { createTempVoice, MAX_PER_GUILD };
