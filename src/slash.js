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
            .setDescription('List everything ZiGBoT can do')
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

module.exports = { buildDefinitions, registerSlashCommands, interactionToIntent, slashActionByCommand };
