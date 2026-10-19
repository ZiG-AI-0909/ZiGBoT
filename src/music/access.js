/**
 * Who may do what with the music player in one server (dashboard settings):
 *  - music_channel_id: song requests (/play, /search) only in that channel.
 *  - music_dj_role_ids: when set, only DJs control playback (skip, stop,
 *    volume, ...). Server managers, the owner, the person who requested the
 *    current song (for skip) and a member alone with the bot always may.
 *  - Controls need the member to be in the bot's voice channel.
 */
const { PermissionFlagsBits } = require('discord.js');

const REQUEST_ACTIONS = new Set(['play', 'search_music']);
const CONTROL_ACTIONS = new Set([
    'pause_music', 'resume_music', 'skip_music', 'stop_music', 'volume_music',
    'loop_music', 'shuffle_music', 'remove_music', 'clear_queue'
]);

function isManager(member) {
    if (!member) return false;
    if (member.guild && String(member.id) === String(member.guild.ownerId)) return true;
    const perms = member.permissions;
    return Boolean(perms?.has?.(PermissionFlagsBits.ManageGuild) || perms?.has?.(PermissionFlagsBits.Administrator));
}

function hasDjRole(member, roleIds) {
    const cache = member?.roles?.cache;
    return Boolean(cache && roleIds.some((id) => cache.has(String(id))));
}

/**
 * Returns a message explaining why `member` may not run `action`, or null.
 * `musicActive` = something is playing or queued in this server.
 */
function musicAccessProblem({ action, member, channel, config, musicActive = false, currentTrack = null }) {
    const cfg = config || {};
    const isControl = CONTROL_ACTIONS.has(action) || (action === 'leave_voice' && musicActive);

    if (REQUEST_ACTIONS.has(action) && cfg.music_channel_id) {
        const ids = [channel?.id, channel?.parentId].filter(Boolean).map(String);
        if (!ids.includes(String(cfg.music_channel_id))) return `🎵 Music requests go in <#${cfg.music_channel_id}>.`;
    }
    if (!isControl) return null;

    const botChannel = member?.guild?.members?.me?.voice?.channel || null;
    if (botChannel && String(member?.voice?.channelId || '') !== String(botChannel.id)) {
        return `🎧 Join <#${botChannel.id}> to control the music.`;
    }

    const djRoles = (cfg.music_dj_role_ids || []).map(String);
    if (djRoles.length === 0 || isManager(member) || hasDjRole(member, djRoles)) return null;
    if (action === 'skip_music' && currentTrack && String(currentTrack.requestedBy) === String(member?.id)) return null;
    const listeners = botChannel?.members ? [...botChannel.members.values()].filter((m) => !m.user?.bot).length : 0;
    if (botChannel && listeners <= 1) return null;
    return `🎧 Only DJs (${djRoles.map((id) => `<@&${id}>`).join(', ')}) can do that here.`;
}

module.exports = { musicAccessProblem, REQUEST_ACTIONS, CONTROL_ACTIONS };
