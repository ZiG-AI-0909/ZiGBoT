/**
 * Slash command definitions for the optional features (sections C-M),
 * appended to the base set in src/slash.js. Each command answers "switched
 * off" until its feature is enabled for the server.
 */
const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');

const TEXT_CHANNELS = [ChannelType.GuildText, ChannelType.GuildAnnouncement];

function communityCommands() {
    const roles = new SlashCommandBuilder()
        .setName('roles')
        .setDescription('Staff: post a panel where members pick their own roles')
        .addStringOption((o) => o.setName('type').setDescription('How members pick').setRequired(true)
            .addChoices({ name: 'Buttons', value: 'buttons' }, { name: 'Dropdown menu', value: 'dropdown' }, { name: 'Reactions', value: 'reactions' }))
        .addRoleOption((o) => o.setName('role1').setDescription('First role').setRequired(true))
        .addStringOption((o) => o.setName('title').setDescription('Panel title').setMaxLength(200));
    for (let i = 2; i <= 5; i += 1) roles.addRoleOption((o) => o.setName(`role${i}`).setDescription(`Role ${i}`));
    roles.setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles);

    return [
        roles,
        new SlashCommandBuilder()
            .setName('suggest')
            .setDescription('Send a suggestion for this server')
            .addStringOption((o) => o.setName('idea').setDescription('Your suggestion').setRequired(true).setMaxLength(1500)),
        new SlashCommandBuilder()
            .setName('community')
            .setDescription('Birthdays, polls, announcements, reminders and server stats')
            .addSubcommand((s) => s.setName('birthday').setDescription('Save your birthday (day and month only)')
                .addIntegerOption((o) => o.setName('day').setDescription('Day of the month').setRequired(true).setMinValue(1).setMaxValue(31))
                .addIntegerOption((o) => o.setName('month').setDescription('Month number').setRequired(true).setMinValue(1).setMaxValue(12)))
            .addSubcommand((s) => s.setName('birthday-remove').setDescription('Remove your saved birthday'))
            .addSubcommand((s) => s.setName('poll').setDescription('Staff: start a poll in this channel')
                .addStringOption((o) => o.setName('question').setDescription('The question').setRequired(true).setMaxLength(300))
                .addStringOption((o) => o.setName('options').setDescription('2 to 10 options separated by |').setRequired(true).setMaxLength(600))
                .addIntegerOption((o) => o.setName('hours').setDescription('How long the poll runs (default 24)').setMinValue(1).setMaxValue(168)))
            .addSubcommand((s) => s.setName('announce').setDescription('Staff: post an announcement')
                .addStringOption((o) => o.setName('message').setDescription('What to announce').setRequired(true).setMaxLength(1800))
                .addChannelOption((o) => o.setName('channel').setDescription('Where (default: this channel)').addChannelTypes(...TEXT_CHANNELS)))
            .addSubcommand((s) => s.setName('remind').setDescription('Staff: post a reminder later')
                .addIntegerOption((o) => o.setName('minutes').setDescription('In how many minutes').setRequired(true).setMinValue(1).setMaxValue(43200))
                .addStringOption((o) => o.setName('message').setDescription('The reminder').setRequired(true).setMaxLength(1800))
                .addChannelOption((o) => o.setName('channel').setDescription('Where (default: this channel)').addChannelTypes(...TEXT_CHANNELS)))
            .addSubcommand((s) => s.setName('stats').setDescription('Show member, channel and role counts'))
    ];
}

function automationCommands() {
    return [
        new SlashCommandBuilder()
            .setName('automation')
            .setDescription('Reminders, scheduled events and automation rules')
            .addSubcommand((s) => s.setName('remind').setDescription('Remind me here later')
                .addIntegerOption((o) => o.setName('minutes').setDescription('In how many minutes').setRequired(true).setMinValue(1).setMaxValue(43200))
                .addStringOption((o) => o.setName('message').setDescription('What to remind you about').setRequired(true).setMaxLength(1800)))
            .addSubcommand((s) => s.setName('event-create').setDescription('Staff: create a Discord scheduled event')
                .addStringOption((o) => o.setName('name').setDescription('Event name').setRequired(true).setMaxLength(100))
                .addIntegerOption((o) => o.setName('starts_in_minutes').setDescription('Starts in how many minutes').setRequired(true).setMinValue(1).setMaxValue(525600))
                .addIntegerOption((o) => o.setName('duration_minutes').setDescription('How long (default 60)').setMinValue(5).setMaxValue(10080))
                .addStringOption((o) => o.setName('location').setDescription('Where (default: Discord)').setMaxLength(100))
                .addStringOption((o) => o.setName('description').setDescription('What it is about').setMaxLength(1000)))
            .addSubcommand((s) => s.setName('events').setDescription('List upcoming scheduled events'))
            .addSubcommand((s) => s.setName('rules').setDescription('Admin: show the automation rules of this server'))
    ];
}

/** Every optional-feature command, as builders (src/slash.js turns them into JSON). */
function featureCommandBuilders() {
    return [...communityCommands(), ...automationCommands()];
}

module.exports = { featureCommandBuilders };
