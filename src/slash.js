/**
 * Slash-command fallback: same router, authorization, confirmation, and audit
 * path as text commands — just a second entry point. Registered per guild on
 * ClientReady so new actions appear immediately in the guild's UI.
 */
const {
    SlashCommandBuilder,
    PermissionFlagsBits
} = require('discord.js');
const { destructiveActions } = require('./tools/router');
const { isOwner } = require('./security/authorization');
const {
    isYouTubeReady,
    getYouTubeStatus,
    handleWatchCommand,
    handleUnwatchCommand,
    handleYtGreetCommand,
    handleYtModCommand,
    handleYtRoastCommand
} = require('./youtube');

// Only the highest-traffic actions get slash commands (per the roadmap);
// everything else stays on the text/voice path.
const slashActionByCommand = new Map([
    ['play', 'play'],
    ['kick', 'kick_member'],
    ['ban', 'ban_member'],
    ['memory', 'memory_status'],
    ['reputation', 'behavior_status'],
    ['help', 'bot_help']
]);

function buildDefinitions() {
    return [
        new SlashCommandBuilder()
            .setName('play')
            .setDescription('Queue a direct HTTPS audio URL')
            .addStringOption((option) => option
                .setName('url')
                .setDescription('Direct https:// audio URL')
                .setRequired(true)),
        new SlashCommandBuilder()
            .setName('kick')
            .setDescription('Kick a member (owner confirmation required)')
            .addUserOption((option) => option
                .setName('member')
                .setDescription('Member to kick')
                .setRequired(true))
            .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers),        new SlashCommandBuilder()
            .setName('ban')
            .setDescription('Ban a member (owner confirmation required)')
            .addUserOption((option) => option
                .setName('member')
                .setDescription('Member to ban')
                .setRequired(true))
            .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),
        new SlashCommandBuilder()
            .setName('memory')
            .setDescription('Owner/admin: inspect ZiGBoT persistent memory (live MongoDB state)')
            .addUserOption((option) => option
                .setName('member')
                .setDescription('Optional: count stored memories for this member'))
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
        new SlashCommandBuilder()
            .setName('reputation')
            .setDescription('Owner/admin: view a member\'s behavior record and standing')
            .addUserOption((option) => option
                .setName('member')
                .setDescription('Optional: defaults to yourself'))
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
        new SlashCommandBuilder()
            .setName('help')
            .setDescription('List everything ZiGBoT can do'),
        // YouTube live-chat watching — owner-only, hidden from non-owners by
        // default_member_permissions and a silent ignore inside the handler.
        new SlashCommandBuilder()
            .setName('watch')
            .setDescription('Owner: watch a YouTube live stream chat by videoId')
            .addStringOption((option) => option
                .setName('videoid')
                .setDescription('11-character YouTube video id'))
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
        new SlashCommandBuilder()
            .setName('unwatch')
            .setDescription('Owner: stop watching the YouTube live stream chat')
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
        new SlashCommandBuilder()
            .setName('ytstatus')
            .setDescription('Owner: inspect the YouTube live-chat watcher state')
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
        new SlashCommandBuilder()
            .setName('ytgreet')
            .setDescription('Owner: enable or disable YouTube greeting replies')
            .addStringOption((option) => option.setName('state').setDescription('on or off').setRequired(true)
                .addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' }))
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
        new SlashCommandBuilder()
            .setName('ytmod')
            .setDescription('Owner: enable or disable YouTube live-chat moderation')
            .addStringOption((option) => option.setName('state').setDescription('on or off').setRequired(true)
                .addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' }))
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
        new SlashCommandBuilder()
            .setName('ytroast')
            .setDescription('Owner: control YouTube roast mode')
            .addStringOption((option) => option.setName('state').setDescription('on, off, or status').setRequired(true)
                .addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' }, { name: 'status', value: 'status' }))
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    ].map((command) => command.toJSON());
}

async function registerSlashCommands(client, settings) {
    const json = buildDefinitions();
    if (settings.slashCommandGuildIds.length > 0) {
        for (const guildId of settings.slashCommandGuildIds) {
            const guild = client.guilds.cache.get(guildId);
            if (guild) await guild.commands.set(json).catch(() => {});
        }
        return;
    }
    await client.application.commands.set(json).catch(() => {});
}

// Convert an interaction into the same intent shape the text path uses.
// Field validation still happens inside executeTool — never here.
async function interactionToIntent(interaction) {
    const action = slashActionByCommand.get(interaction.commandName);
    if (!action) return null;

    if (action === 'play') {
        return { action, target: interaction.options.getString('url', true).trim().slice(0, 2000) };
    }
    if (action === 'kick_member' || action === 'ban_member') {
        const user = interaction.options.getUser('member', true);
        return { action, target: `<@${user.id}>` };
    }
    if (action === 'memory_status' || action === 'behavior_status') {
        // Optional member: only set when the owner picked one.
        const user = interaction.options.getUser('member');
        return user ? { action, target: `<@${user.id}>` } : { action };
    }
    return { action };
}

// FakeMessage shape so handleWatchCommand can reuse the existing gating.
const ytMessageShape = (authorId) => ({ author: { id: authorId } });

/** YouTube slash commands. YouTube failures never crash the Discord path. */
async function runYouTubeInteraction(interaction, settings, client) {
    const isDiscordOwner = isOwner(interaction.user.id, settings)
        || interaction.user.id === settings.serverOwnerId;
    if (!isDiscordOwner) return null; // silent non-owner ignore

    try {
        if (interaction.commandName === 'watch') {
            const videoId = (interaction.options.getString('videoid') || '').trim().slice(0, 32);
            return await handleWatchCommand(videoId, true);
        }
        if (interaction.commandName === 'unwatch') {
            return await handleUnwatchCommand(true);
        }
        if (interaction.commandName === 'ytstatus') {
            const status = getYouTubeStatus();
            return [
                `enabled: ${status.enabled}`,
                `ownerId: ${status.ownerId || 'not resolved'}`,
                `watching: ${status.watching || 'none'}`,
                `autoDetect: ${status.autoDetect ? 'on' : 'off'}`,
                `greetings: ${status.greetings ? 'on' : 'off'}`,
                `replies this stream: ${status.repliesSent}`,
                `total bot chat messages this stream: ${status.messagesSent}`,
                `moderation: ${status.moderation ? 'on' : 'off'}`,
                `moderation actions this stream: ${status.moderationActions}`,
                `roast mode: ${status.roastMode ? 'on' : 'off'}`,
                `roasts sent this stream: ${status.roastsSent}`,
                `roast AI calls this stream: ${status.roastAiCalls}`,
                `quota used today: ${status.quotaUsed}/${status.quotaBudget ?? 'unknown'}`
            ].join(' | ');
        }
        if (interaction.commandName === 'ytgreet') {
            return await handleYtGreetCommand(interaction.options.getString('state', true), true);
        }
        if (interaction.commandName === 'ytmod') {
            return await handleYtModCommand(interaction.options.getString('state', true), true);
        }
        if (interaction.commandName === 'ytroast') {
            return await handleYtRoastCommand(interaction.options.getString('state', true), true);
        }
    } catch (error) {
        // YouTube problems must never fall through to a Discord crash.
        console.error(`[ZiGBoT YT SLASH] ${error.message}`);
        return '❌ YouTube command failed; check the server logs.';
    }
    return null;
}

module.exports = {
    buildDefinitions,
    registerSlashCommands,
    interactionToIntent,
    slashActionByCommand,
    runYouTubeInteraction
};
