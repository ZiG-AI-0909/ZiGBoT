/**
 * /summarychannels: admins choose the channels where members who opted in to
 * conversation summaries may also have their OWN ordinary messages read.
 *
 * Hidden from members by default (Manage Server), and every use is ALSO
 * checked server-side with the router's owner/admin gate (resolveContext).
 * Replies are ephemeral and mention nobody. Adding a channel never makes
 * anyone's messages readable by itself: a member must opt in (again) after
 * seeing the channel in their consent notice.
 */
const { ChannelType, MessageFlags, PermissionFlagsBits } = require('discord.js');

const ALLOWED_CHANNEL_TYPES = new Set([ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildVoice]);
const NO_MENTIONS = { parse: [] };

// null when the channel may be a summary channel, otherwise the reason.
function summaryChannelProblem(channel, guild) {
    if (!channel || !guild || String(channel.guildId) !== String(guild.id)) return 'That channel is not in this server.';
    if (channel.isThread?.()) return 'Threads cannot be summary channels.';
    if (!ALLOWED_CHANNEL_TYPES.has(channel.type)) return 'Only text, announcement, and voice-chat channels can be summary channels.';
    if (channel.nsfw === true) return 'Age-restricted (NSFW) channels cannot be summary channels.';
    const me = guild.members?.me;
    const permissions = me && channel.permissionsFor?.(me);
    if (!permissions || !permissions.has(PermissionFlagsBits.ViewChannel)) return 'I cannot see that channel, so it cannot be a summary channel.';
    return null;
}

const mentionList = (ids) => ids.map((id) => `<#${id}>`).join(', ');

function createSummaryChannelCommands({ brain, summaryService }) {
    const logFailure = (subcommand, error) => {
        console.error(`[ZiGBoT SUMMARY CHANNELS] ${subcommand} failed: ${error?.code || error?.name || 'Error'}`);
    };

    // resolveContext() -> { authorized, reason, channelsFeatureOn, audit(event) }
    async function handleSlash(interaction, { resolveContext }) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const send = (content) => interaction.editReply({ content, allowedMentions: NO_MENTIONS });
        if (!interaction.guild) return send('Use this command inside a server.');
        const subcommand = interaction.options.getSubcommand();
        const ctx = await resolveContext();
        if (!ctx.authorized) {
            await ctx.audit?.({ action: `summarychannels_${subcommand}`, result: 'DENIED' });
            return send(`❌ ${ctx.reason || 'Only the server owner or an admin can manage summary channels.'}`);
        }
        if (!brain.isMemoryAvailable()) return send('⚠️ Persistent memory is temporarily unavailable (database unreachable). Nothing was read or changed.');
        const guildId = interaction.guild.id;
        const featureNote = ctx.channelsFeatureOn ? '' : '\nℹ️ Channel summaries are switched off on this bot right now, so these channels are not read yet.';

        try {
            if (subcommand === 'list') {
                const ids = await brain.getSummaryChannels(guildId);
                if (ids.length === 0) return send(`No summary channels are set.${featureNote}`);
                return send(`📋 Summary channels (${ids.length}/${brain.SUMMARY_CHANNELS_MAX}): ${mentionList(ids)}\nOnly members who opted in with \`/memory summaries\` are read here, and only in the channels they were shown when they opted in.${featureNote}`);
            }

            const channel = interaction.options.getChannel('channel', true);
            if (subcommand === 'add') {
                const problem = summaryChannelProblem(channel, interaction.guild);
                if (problem) {
                    await ctx.audit?.({ action: 'summarychannels_add', target: channel?.id, result: 'REFUSED', details: { reason: problem } });
                    return send(`❌ ${problem} Nothing changed.`);
                }
                const result = await brain.addSummaryChannel(guildId, channel.id, interaction.user.id);
                if (result.status === 'exists') return send(`ℹ️ <#${channel.id}> is already a summary channel.${featureNote}`);
                if (result.status === 'full') return send(`❌ This server already has ${brain.SUMMARY_CHANNELS_MAX} summary channels (the maximum). Remove one first.`);
                summaryService.invalidateChannels(guildId);
                await ctx.audit?.({ action: 'summarychannels_add', target: channel.id, result: 'SUCCESS' });
                return send(`✅ <#${channel.id}> is now a summary channel. Members' messages there are read only after each member opts in (again) with \`/memory summaries state:on\` and sees this channel listed.${featureNote}`);
            }

            if (subcommand === 'remove') {
                const result = await brain.removeSummaryChannel(guildId, channel.id, interaction.user.id);
                if (result.status === 'missing') return send(`ℹ️ <#${channel.id}> is not a summary channel. Nothing changed.`);
                summaryService.invalidateChannels(guildId);
                await ctx.audit?.({ action: 'summarychannels_remove', target: channel.id, result: 'SUCCESS' });
                return send(`🗑️ <#${channel.id}> is no longer a summary channel. Messages there stop being read right away, including any not yet summarised.`);
            }
            return send('❌ Unknown subcommand.');
        } catch (error) {
            if (error?.name === 'MemoryValidationError') return send(`❌ ${error.message}`);
            logFailure(subcommand, error);
            return send('❌ The database did not confirm the change, so the channel list may not have changed. Check with `/summarychannels list`.');
        }
    }

    return { handleSlash };
}

module.exports = { createSummaryChannelCommands, summaryChannelProblem, ALLOWED_CHANNEL_TYPES };
