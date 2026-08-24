const {
    joinVoiceChannel,
    getVoiceConnection,
    entersState,
    VoiceConnectionStatus
} = require('@discordjs/voice');
const { ChannelType, PermissionFlagsBits } = require('discord.js');
const { clearGuild } = require('../music/player');

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

    try {
        await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
    } catch (error) {
        connection.destroy();
        throw new Error('ZiGBoT could not connect to that voice channel.');
    }

    return voiceChannel;
}

function leaveGuildVoice(guild) {
    const connection = getVoiceConnection(guild.id);
    if (!connection) return false;
    clearGuild(guild.id);
    connection.destroy();
    return true;
}

function isInGuildVoice(guild) {
    return Boolean(getVoiceConnection(guild.id));
}

module.exports = { joinMemberVoiceChannel, leaveGuildVoice, isInGuildVoice };
