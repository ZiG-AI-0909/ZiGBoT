const {
    joinVoiceChannel,
    getVoiceConnection,
    entersState,
    VoiceConnectionStatus
} = require('@discordjs/voice');
const { ChannelType, PermissionFlagsBits } = require('discord.js');
const { clearGuild } = require('../music/player');

const RECONNECT_LIMIT = 3;
const RECONNECT_BASE_DELAY_MS = 2_000;
const wrappedConnections = new Map(); // guildId -> raw connection

/**
 * Wraps a raw @discordjs/voice connection with Disconnected/Destroyed handling.
 * Transient disconnects (channel moves, regional blips) retry up to
 * RECONNECT_LIMIT times with capped exponential backoff instead of silently
 * dying mid-playback. The wrapper keeps the public API of the raw connection
 * (subscribe/destroy/state) so the music player keeps working unchanged.
 */
function attachReconnectHandling(rawConnection, voiceChannel) {
    if (wrappedConnections.has(voiceChannel.guild.id)) return rawConnection;
    wrappedConnections.set(voiceChannel.guild.id, rawConnection);

    let attempts = 0;
    let reconnecting = false;

    rawConnection.on(VoiceConnectionStatus.Disconnected, async () => {
        if (reconnecting) return;
        reconnecting = true;

        try {
            // Destroyed connections are intentional leaves; never resurrect those.
            if (rawConnection.state.status === VoiceConnectionStatus.Destroyed) return;

            if (attempts >= RECONNECT_LIMIT) {
                console.error(`[ZiGBoT VOICE] Reconnect limit reached in ${voiceChannel.guild.name}; cleaning up.`);
                wrappedConnections.delete(voiceChannel.guild.id);
                clearGuild(voiceChannel.guild.id);
                try { rawConnection.destroy(); } catch { /* already destroyed */ }
                return;
            }

            attempts += 1;
            const delay = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** (attempts - 1), 15_000);
            await new Promise((resolve) => setTimeout(resolve, delay));

            // Signal-wait: discord.js recommends racing Ready against a manual
            // destroy signal so stale Disconnects do not hang forever.
            await Promise.race([
                entersState(rawConnection, VoiceConnectionStatus.Signalling, 5_000),
                entersState(rawConnection, VoiceConnectionStatus.Connecting, 5_000)
            ]);
            await entersState(rawConnection, VoiceConnectionStatus.Ready, 15_000);
            attempts = 0;
            console.log(`[ZiGBoT VOICE] Reconnected to ${voiceChannel.name}.`);
        } catch {
            // Still disconnected after the grace window: destroy() triggers the
            // next Disconnected event, which schedules the next retry or gives up.
            try { rawConnection.destroy(); } catch { /* already destroyed */ }
        } finally {
            reconnecting = false;
        }
    });

    rawConnection.on(VoiceConnectionStatus.Destroyed, () => {
        wrappedConnections.delete(voiceChannel.guild.id);
    });

    return rawConnection;
}

async function joinMemberVoiceChannel(message) {
    const voiceChannel = message.member?.voice?.channel;
    if (!voiceChannel || voiceChannel.type !== ChannelType.GuildVoice) {
        throw new Error('Join a voice channel first, then ask ZiGBoT to join it.');
    }

    const permissions = voiceChannel.permissionsFor(message.guild.members.me);
    if (!permissions?.has([PermissionFlagsBits.Connect, PermissionFlagsBits.Speak])) {
        throw new Error('ZiGBoT needs Connect and Speak permission in that voice channel.');
    }

    const connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: voiceChannel.guild.id,
        adapterCreator: voiceChannel.guild.voiceAdapterCreator,
        selfDeaf: false
    });

    attachReconnectHandling(connection, voiceChannel);

    try {
        await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
    } catch (error) {
        wrappedConnections.delete(voiceChannel.guild.id);
        connection.destroy();
        throw new Error('ZiGBoT could not connect to that voice channel.');
    }

    return voiceChannel;
}

function leaveGuildVoice(guild) {
    const connection = getVoiceConnection(guild.id);
    if (!connection) return false;
    wrappedConnections.delete(guild.id);
    clearGuild(guild.id);
    connection.destroy();
    return true;
}

function isInGuildVoice(guild) {
    return Boolean(getVoiceConnection(guild.id));
}

module.exports = { joinMemberVoiceChannel, leaveGuildVoice, isInGuildVoice, attachReconnectHandling };
