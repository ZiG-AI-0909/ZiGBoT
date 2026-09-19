const {
    PermissionFlagsBits,
    ChannelType
} = require('discord.js');
const { ownerAuthorization, botPermission } = require('../security/authorization');
const { auditLog } = require('../logging/auditLog');
const { joinMemberVoiceChannel, leaveGuildVoice, isInGuildVoice } = require('../voice/voiceManager');
const music = require('../music/player');
const { startListening, stopListening } = require('../voice/voiceConversation');

const adminActions = new Set([
    'send_message', 'create_role', 'delete_role', 'add_role', 'remove_role',
    'create_channel', 'delete_channel', 'rename_channel', 'timeout_member',
    'kick_member', 'ban_member', 'unban_member', 'delete_messages',
    'start_voice_listening', 'stop_voice_listening', 'warn_member'
]);

// Destructive actions require interactive Confirm/Cancel before execution.
// timeout_member is punitive, so it belongs here alongside kick/ban/delete.
const destructiveActions = new Set([
    'delete_role', 'remove_role', 'delete_channel', 'timeout_member',
    'kick_member', 'ban_member', 'unban_member', 'delete_messages',
    'warn_member'
]);

// Aliases accept common phrasings and canonicalize to the action above.
const actionAliases = new Map([
    ['kick', 'kick_member'],
    ['ban', 'ban_member'],
    ['unban', 'unban_member'],
    ['timeout', 'timeout_member'],
    ['warn', 'timeout_member'],
    ['play_music', 'play'],
    ['play_track', 'play'],
    ['pause', 'pause_music'],
    ['resume', 'resume_music'],
    ['skip', 'skip_music'],
    ['stop', 'stop_music'],
    ['queue', 'queue_music'],
    ['nowplaying', 'now_playing'],
    ['volume', 'volume_music'],
    ['loop', 'loop_music'],
    ['help', 'bot_help'],
    ['serverinfo', 'get_server_info'],
    ['memberinfo', 'get_member_info'],
    ['channelinfo', 'get_channel_info'],
    ['join', 'join_voice'],
    ['leave', 'leave_voice']
]);

// Every supported action plus the permission each requires inside a guild.
// The catalog is the source of truth for gating and /help output.
const actionCatalog = new Map([
    ['send_message', { permission: PermissionFlagsBits.SendMessages, description: 'Send a message to this channel.' }],
    ['create_role', { permission: PermissionFlagsBits.ManageRoles, description: 'Create a role.' }],
    ['delete_role', { permission: PermissionFlagsBits.ManageRoles, description: 'Delete a role.' }],
    ['add_role', { permission: PermissionFlagsBits.ManageRoles, description: 'Give a role to a member.' }],
    ['remove_role', { permission: PermissionFlagsBits.ManageRoles, description: 'Take a role from a member.' }],
    ['create_channel', { permission: PermissionFlagsBits.ManageChannels, description: 'Create a text channel.' }],
    ['delete_channel', { permission: PermissionFlagsBits.ManageChannels, description: 'Delete a text channel.' }],
    ['rename_channel', { permission: PermissionFlagsBits.ManageChannels, description: 'Rename a text channel (channel = existing name, message = new name).' }],
    ['timeout_member', { permission: PermissionFlagsBits.ModerateMembers, description: 'Timeout a member for a number of minutes.' }],
    ['kick_member', { permission: PermissionFlagsBits.KickMembers, description: 'Kick a member.' }],
    ['ban_member', { permission: PermissionFlagsBits.BanMembers, description: 'Ban a member.' }],
    ['unban_member', { permission: PermissionFlagsBits.BanMembers, description: 'Unban a user by ID.' }],
    ['delete_messages', { permission: PermissionFlagsBits.ManageMessages, description: 'Bulk delete 1-100 recent messages in this channel.' }],
    ['start_voice_listening', { permission: PermissionFlagsBits.Connect, description: 'Start temporary push-to-talk voice listening.' }],
    ['stop_voice_listening', { permission: PermissionFlagsBits.Connect, description: 'Stop voice listening.' }],
    ['get_server_info', { permission: null, description: 'Show server info.' }],
    ['get_member_info', { permission: null, description: 'Show info about a member.' }],
    ['get_channel_info', { permission: null, description: 'Show info about a channel.' }],
    ['join_voice', { permission: null, description: 'Join your current voice channel.' }],
    ['leave_voice', { permission: null, description: 'Leave the voice channel.' }],
    ['voice_status', { permission: null, description: 'Show voice connection status.' }],
    ['play', { permission: null, description: 'Queue a direct HTTPS audio URL.' }],
    ['pause_music', { permission: null, description: 'Pause playback.' }],
    ['resume_music', { permission: null, description: 'Resume playback.' }],
    ['skip_music', { permission: null, description: 'Skip the current track.' }],
    ['stop_music', { permission: null, description: 'Stop playback and clear the queue.' }],
    ['queue_music', { permission: null, description: 'Show the music queue.' }],
    ['now_playing', { permission: null, description: 'Show the currently playing track.' }],
    ['volume_music', { permission: null, description: 'Set playback volume (0-100).' }],
    ['loop_music', { permission: null, description: 'Toggle looping the current track.' }],
    ['warn_member', { permission: PermissionFlagsBits.ModerateMembers, description: 'Warn a member (destructive: needs confirmation).' }],
    ['list_warnings', { permission: null, description: 'List warnings for a member.' }],
    ['bot_help', { permission: null, description: 'List everything ZiGBoT can do.' }]
]);

function normalizeAction(rawAction) {
    if (typeof rawAction !== 'string') return null;
    const key = rawAction.trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (actionCatalog.has(key)) return key;
    const aliased = actionAliases.get(key);
    return aliased || null;
}

function text(value, field, max = 100) {
    if (typeof value !== 'string' || !value.trim() || value.length > max) {
        throw new Error(`${field} is required and must be ${max} characters or fewer.`);
    }
    return value.trim();
}

function findMember(guild, target) {
    if (!target) return null;
    const id = target.match(/^<@!?(\d+)>$/)?.[1] || target;
    return guild.members.cache.get(id)
        || guild.members.cache.find((member) => [member.user.username, member.displayName, member.user.tag].some((name) => name.toLowerCase() === target.toLowerCase()));
}

function findRole(guild, name) {
    if (!name) return null;
    const id = name.match(/^<@&(\d+)>$/)?.[1] || name;
    return guild.roles.cache.get(id) || guild.roles.cache.find((role) => role.name.toLowerCase() === name.toLowerCase());
}

function findChannel(guild, name) {
    if (!name) return null;
    const id = name.match(/^<#(\d+)>$/)?.[1] || name;
    return guild.channels.cache.get(id) || guild.channels.cache.find((channel) => channel.name.toLowerCase() === name.replace(/^#/, '').toLowerCase());
}

async function denied(message, settings, intent, reason) {
    await auditLog({ message, settings, event: 'SECURITY', action: intent.action, target: intent.target, result: 'DENIED', details: { reason } });
    return `❌ ${reason}`;
}

// Owner/admin gate. Two-layer check:
//   1. serverOwner() — the strict original guarantee (config ID = author ID =
//      actual guild owner), kept intact as a fallback, extended per guild by
//      GUILD_OWNER_IDS and ADMIN_ROLE_NAMES.
//   2. botPermission() — the bot's own Discord permissions (unchanged).
function isAuthorizedActor(message, settings) {
    const strictOwner = ownerAuthorization(message, settings);
    if (strictOwner.allowed) return { allowed: true };

    const authorId = message.author?.id;
    if (!authorId || !message.guild) return { allowed: false, reason: strictOwner.reason };

    // Per-guild configured owner IDs (multi-server support).
    if (settings.guildOwnerIds instanceof Map && settings.guildOwnerIds.get(message.guild.id) === authorId) {
        return { allowed: true };
    }

    // Per-guild admin roles: member has one of the configured role names.
    const adminRoleNames = settings.guildAdminRoleNames?.get?.(message.guild.id);
    if (Array.isArray(adminRoleNames) && adminRoleNames.length > 0 && message.member?.roles?.cache) {
        const normalized = new Set(adminRoleNames.map((name) => String(name).trim().toLowerCase()).filter(Boolean));
        const hasAdminRole = message.member.roles.cache.some((role) => normalized.has(role.name.trim().toLowerCase()));
        if (hasAdminRole) return { allowed: true };
    }

    return { allowed: false, reason: strictOwner.reason };
}

async function authorize(message, settings, intent, permission) {
    const owner = isAuthorizedActor(message, settings);
    if (!owner.allowed) return denied(message, settings, intent, owner.reason);
    const permissionResult = botPermission(message.guild, permission);
    if (!permissionResult.allowed) return denied(message, settings, intent, permissionResult.reason);
    return null;
}

async function executeTool(message, settings, intent, context = {}) {
    if (!message.guild) return '❌ These tools only work inside a server.';
    let target = intent.target || intent.channel || intent.role || 'server';

    if (adminActions.has(intent.action)) {
        const failure = await authorize(message, settings, intent, actionCatalog.get(intent.action).permission);
        if (failure) return failure;
    }

    // Warn storage is optional: warns are no-ops until the database is wired.
    const warnStore = context.warnStore || null;

    try {
        const { guild } = message;
        let result;

        switch (intent.action) {
            case 'bot_help': {
                result = '**ZiGBoT actions:**\n' + [...actionCatalog.values()]
                    .map(({ description }) => `• ${description}`)
                    .join('\n');
                break;
            }
            case 'get_server_info':
            case 'get_server_info':
                result = `**${guild.name}**\nMembers: ${guild.memberCount}\nChannels: ${guild.channels.cache.size}\nCreated: <t:${Math.floor(guild.createdTimestamp / 1000)}:D>`;
                break;
            case 'get_member_info': {
                const member = findMember(guild, text(intent.target, 'Member'));
                if (!member) return '❌ I could not find that member.';
                result = `**${member.displayName}**\nID: ${member.id}\nJoined: <t:${Math.floor(member.joinedTimestamp / 1000)}:D>`;
                break;
            }
            case 'get_channel_info': {
                const channel = findChannel(guild, text(intent.channel || intent.target, 'Channel'));
                if (!channel) return '❌ I could not find that channel.';
                result = `**#${channel.name}**\nType: ${channel.type}\nID: ${channel.id}`;
                break;
            }
            case 'join_voice': {
                const voiceChannel = await joinMemberVoiceChannel(message);
                result = `✅ Joined **${voiceChannel.name}**. Voice capture is not enabled; I will not record or process audio yet.`;
                target = voiceChannel.name;
                break;
            }
            case 'leave_voice':
                result = leaveGuildVoice(guild)
                    ? '✅ Left the voice channel.'
                    : 'ℹ️ I am not currently in a voice channel.';
                break;
            case 'voice_status':
                result = isInGuildVoice(guild)
                    ? '🔊 I am connected to a voice channel. Voice capture is disabled.'
                    : '🔇 I am not connected to a voice channel.';
                break;
            case 'start_voice_listening':
                if (settings.voiceMode !== 'push-to-talk') return '❌ Voice listening is disabled by configuration.';
                if (typeof context.onVoiceTranscript !== 'function') return '❌ Local voice processing is not configured.';
                result = startListening(guild, settings, context.onVoiceTranscript)
                    ? '✅ I am listening temporarily. Use `@ZiGBoT stop listening` when finished.'
                    : 'ℹ️ I am already listening.';
                break;
            case 'stop_voice_listening':
                result = stopListening(guild.id)
                    ? '✅ Voice listening stopped. Temporary audio is deleted after processing.'
                    : 'ℹ️ I was not listening.';
                break;
            case 'play': {
                if (!isInGuildVoice(guild)) return '❌ Join a voice channel first.';
                const added = music.addTrack(guild.id, text(intent.target, 'Audio URL', 2000), message.author.id);
                result = `✅ Queued audio track at position ${added.position}.`;
                target = added.track.url;
                break;
            }
            case 'pause_music':
                result = music.pause(guild.id) ? '⏸️ Music paused.' : '❌ Music is not playing.';
                break;
            case 'resume_music':
                result = music.resume(guild.id) ? '▶️ Music resumed.' : '❌ Music is not paused.';
                break;
            case 'skip_music':
                result = music.skip(guild.id) ? '⏭️ Skipped the current track.' : '❌ Nothing is playing.';
                break;
            case 'stop_music':
                music.stop(guild.id);
                result = '⏹️ Music stopped and the queue was cleared.';
                break;
            case 'queue_music': {
                const currentQueue = music.queue(guild.id);
                result = currentQueue.current
                    ? `🎵 Now playing: ${currentQueue.current.url}\nQueued tracks: ${currentQueue.tracks.length}`
                    : '🎵 Nothing is currently playing.';
                break;
            }
            case 'now_playing': {
                const currentQueue = music.queue(guild.id);
                result = currentQueue.current ? `🎵 Now playing: ${currentQueue.current.url}` : '🎵 Nothing is currently playing.';
                break;
            }
            case 'volume_music':
                result = `🔊 Volume set to ${music.setVolume(guild.id, intent.volume)}%.`;
                break;
            case 'loop_music':
                result = music.toggleLoop(guild.id) ? '🔁 Loop enabled.' : '➡️ Loop disabled.';
                break;            case 'send_message': {
                const content = text(intent.message, 'Message', 1900);
                // Lock pings down: an AI-authored message may only ever notify
                // real users already named via <@id>, never @everyone/@here/roles.
                await message.channel.send(content, { allowedMentions: { parse: ['users'] } });
                result = '✅ Message sent.';
                break;
            }
            case 'create_role': {
                const name = text(intent.role || intent.target, 'Role name', 100);
                const role = await guild.roles.create({ name, reason: intent.reason || 'Requested by server owner through ZiGBoT' });
                result = `✅ Created the ${role} role.`;
                target = name;
                break;
            }
            case 'delete_role': {
                const role = findRole(guild, text(intent.role || intent.target, 'Role'));
                if (!role) return '❌ I could not find that role.';
                if (role.managed || role.position >= guild.members.me.roles.highest.position) return '❌ I cannot manage that role.';
                await role.delete(intent.reason || 'Requested by server owner through ZiGBoT');
                result = `✅ Deleted the ${role.name} role.`;
                break;
            }
            case 'add_role':
            case 'remove_role': {
                const member = findMember(guild, text(intent.target, 'Member'));
                const role = findRole(guild, text(intent.role, 'Role'));
                if (!member) return '❌ I could not find that member.';
                if (!role) return '❌ I could not find that role.';
                if (role.managed || role.position >= guild.members.me.roles.highest.position) return '❌ I cannot manage that role.';
                if (intent.action === 'add_role') await member.roles.add(role, intent.reason);
                else await member.roles.remove(role, intent.reason);
                result = `✅ ${intent.action === 'add_role' ? 'Added' : 'Removed'} ${role.name} ${intent.action === 'add_role' ? 'to' : 'from'} ${member.displayName}.`;
                break;
            }
            case 'create_channel': {
                const name = text(intent.channel || intent.target, 'Channel name', 100).replace(/^#/, '').replace(/\s+/g, '-').toLowerCase();
                const channel = await guild.channels.create({ name, type: ChannelType.GuildText, reason: intent.reason || 'Requested by server owner through ZiGBoT' });
                result = `✅ Created ${channel}.`;
                target = name;
                break;
            }
            case 'delete_channel': {
                const channel = findChannel(guild, text(intent.channel || intent.target, 'Channel'));
                if (!channel || !channel.isTextBased()) return '❌ I could not find that text channel.';
                await channel.delete(intent.reason || 'Requested by server owner through ZiGBoT');
                result = `✅ Deleted #${channel.name}.`;
                break;
            }
            case 'rename_channel': {
                // Schema contract: channel = existing channel, message = new name.
                const channel = findChannel(guild, text(intent.channel || intent.target, 'Channel'));
                const name = text(intent.message, 'New channel name', 100).replace(/^#/, '').replace(/\s+/g, '-').toLowerCase();
                if (!channel) return '❌ I could not find that channel.';
                await channel.setName(name, intent.reason || 'Requested by server owner through ZiGBoT');
                result = `✅ Renamed the channel to #${name}.`;
                break;
            }
            case 'warn_member': {
                if (!warnStore) return '❌ Warning storage is not configured.';
                const member = findMember(guild, text(intent.target, 'Member'));
                if (!member) return '❌ I could not find that member.';
                const reason = text(intent.reason || intent.message || 'No reason provided', 'Reason', 500);
                const warning = await warnStore.addWarning(guild.id, member.id, reason, message.author.id);
                const warningCount = await warnStore.countWarnings(guild.id, member.id);
                result = `⚠️ Warned ${member.displayName} (warning #${warning.id}): ${reason}. They now have ${warningCount} warning(s).`;
                target = member.displayName;
                break;
            }
            case 'list_warnings': {
                if (!warnStore) return '❌ Warning storage is not configured.';
                const member = findMember(guild, text(intent.target, 'Member'));
                if (!member) return '❌ I could not find that member.';
                const warnings = await warnStore.listWarnings(guild.id, member.id);
                if (warnings.length === 0) {
                    result = `ℹ️ ${member.displayName} has no warnings.`;
                } else {
                    result = `⚠️ Warnings for ${member.displayName}:\n` + warnings
                        .map((warning) => `• #${warning.id} — ${warning.reason} (by <@${warning.issued_by}>, <t:${Math.floor(warning.created_at / 1000)}:R>)`)
                        .join('\n');
                }
                target = member.displayName;
                break;
            }
            case 'timeout_member': {
                const member = findMember(guild, text(intent.target, 'Member'));
                const minutes = Number(intent.durationMinutes);
                if (!member) return '❌ I could not find that member.';
                if (!Number.isInteger(minutes) || minutes < 1 || minutes > 40320) return '❌ Timeout duration must be between 1 minute and 28 days.';
                await member.timeout(minutes * 60 * 1000, intent.reason || 'Requested by server owner through ZiGBoT');
                result = `✅ Timed out ${member.displayName} for ${minutes} minutes.`;
                break;
            }
            case 'kick_member': {
                const member = findMember(guild, text(intent.target, 'Member'));
                if (!member) return '❌ I could not find that member.';
                if (!member.kickable) return '❌ I cannot kick that member because of role hierarchy or permissions.';
                await member.kick(intent.reason || 'Requested by server owner through ZiGBoT');
                result = `✅ Kicked ${member.displayName}.`;
                break;
            }
            case 'ban_member': {
                const member = findMember(guild, text(intent.target, 'Member'));
                if (!member) return '❌ I could not find that member.';
                if (!member.bannable) return '❌ I cannot ban that member because of role hierarchy or permissions.';
                await member.ban({ reason: intent.reason || 'Requested by server owner through ZiGBoT' });
                result = `✅ Banned ${member.displayName}.`;
                break;
            }
            case 'unban_member': {
                const targetId = text(intent.target, 'User ID');
                await guild.members.unban(targetId, intent.reason || 'Requested by server owner through ZiGBoT');
                result = `✅ Unbanned ${targetId}.`;
                break;
            }
            case 'delete_messages': {
                const count = Number(intent.count);
                if (!Number.isInteger(count) || count < 1 || count > 100) return '❌ Message count must be between 1 and 100.';
                const deleted = await message.channel.bulkDelete(count, true);
                result = `✅ Deleted ${deleted.size} messages.`;
                target = `#${message.channel.name}`;
                break;
            }
            default:
                return '❌ I could not map that request to a supported tool.';
        }

        await auditLog({ message, settings, event: 'ADMIN ACTION', action: intent.action, target, result: 'SUCCESS', details: { reason: intent.reason } });
        return result;
    } catch (error) {
        await auditLog({ message, settings, event: 'ADMIN ACTION', action: intent.action, target, result: 'FAILED', details: { error: error.message } });
        return `❌ I couldn't complete that action: ${error.message}`;
    }
}

module.exports = { executeTool, adminActions, destructiveActions, actionCatalog, actionAliases, normalizeAction, isAuthorizedActor };
