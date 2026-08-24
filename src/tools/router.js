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
    'start_voice_listening', 'stop_voice_listening'
]);

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

async function authorize(message, settings, intent, permission) {
    const owner = ownerAuthorization(message, settings);
    if (!owner.allowed) return denied(message, settings, intent, owner.reason);
    const permissionResult = botPermission(message.guild, permission);
    if (!permissionResult.allowed) return denied(message, settings, intent, permissionResult.reason);
    return null;
}

async function executeTool(message, settings, intent, context = {}) {
    if (!message.guild) return '❌ These tools only work inside a server.';
    let target = intent.target || intent.channel || intent.role || 'server';

    if (adminActions.has(intent.action)) {
        const permissions = {
            send_message: PermissionFlagsBits.SendMessages,
            create_role: PermissionFlagsBits.ManageRoles,
            delete_role: PermissionFlagsBits.ManageRoles,
            add_role: PermissionFlagsBits.ManageRoles,
            remove_role: PermissionFlagsBits.ManageRoles,
            create_channel: PermissionFlagsBits.ManageChannels,
            delete_channel: PermissionFlagsBits.ManageChannels,
            rename_channel: PermissionFlagsBits.ManageChannels,
            timeout_member: PermissionFlagsBits.ModerateMembers,
            kick_member: PermissionFlagsBits.KickMembers,
            ban_member: PermissionFlagsBits.BanMembers,
            unban_member: PermissionFlagsBits.BanMembers,
            delete_messages: PermissionFlagsBits.ManageMessages
            , start_voice_listening: PermissionFlagsBits.Connect
            , stop_voice_listening: PermissionFlagsBits.Connect
        };
        const failure = await authorize(message, settings, intent, permissions[intent.action]);
        if (failure) return failure;
    }

    try {
        const { guild } = message;
        let result;

        switch (intent.action) {
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
                break;
            case 'send_message': {
                const content = text(intent.message, 'Message', 1900);
                await message.channel.send(content);
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
                const channel = findChannel(guild, text(intent.channel || intent.target, 'Channel'));
                const name = text(intent.message || intent.role, 'New channel name', 100).replace(/^#/, '').replace(/\s+/g, '-').toLowerCase();
                if (!channel) return '❌ I could not find that channel.';
                await channel.setName(name, intent.reason || 'Requested by server owner through ZiGBoT');
                result = `✅ Renamed the channel to #${name}.`;
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

module.exports = { executeTool, adminActions };
