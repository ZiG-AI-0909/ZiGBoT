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

function engagementCommands() {
    const messageId = (o) => o.setName('message_id').setDescription('ID of the message (right-click, Copy Message ID)').setRequired(true).setMinLength(17).setMaxLength(20);
    return [
        new SlashCommandBuilder()
            .setName('level')
            .setDescription('XP, levels and the leaderboard')
            .addSubcommand((s) => s.setName('rank').setDescription('Show a rank card')
                .addUserOption((o) => o.setName('member').setDescription('Whose rank (default: yours)')))
            .addSubcommand((s) => s.setName('leaderboard').setDescription('Top members by XP')
                .addIntegerOption((o) => o.setName('page').setDescription('Page number').setMinValue(1))),
        new SlashCommandBuilder()
            .setName('eco')
            .setDescription('Virtual coins: daily reward, shop, inventory, trading and achievements')
            .addSubcommand((s) => s.setName('daily').setDescription('Claim your daily reward'))
            .addSubcommand((s) => s.setName('balance').setDescription('Show coins')
                .addUserOption((o) => o.setName('member').setDescription('Whose balance (default: yours)')))
            .addSubcommand((s) => s.setName('shop').setDescription('See the shop'))
            .addSubcommand((s) => s.setName('buy').setDescription('Buy a shop item')
                .addStringOption((o) => o.setName('item').setDescription('Item name').setRequired(true).setMaxLength(40)))
            .addSubcommand((s) => s.setName('inventory').setDescription('Show items')
                .addUserOption((o) => o.setName('member').setDescription('Whose items (default: yours)')))
            .addSubcommand((s) => s.setName('achievements').setDescription('Show your achievements'))
            .addSubcommand((s) => s.setName('trade').setDescription('Offer a trade (they must accept)')
                .addUserOption((o) => o.setName('member').setDescription('Who to trade with').setRequired(true))
                .addIntegerOption((o) => o.setName('give_coins').setDescription('Coins you give').setMinValue(0).setMaxValue(1000000000))
                .addStringOption((o) => o.setName('give_item').setDescription('Item you give').setMaxLength(40))
                .addIntegerOption((o) => o.setName('want_coins').setDescription('Coins you want').setMinValue(0).setMaxValue(1000000000))
                .addStringOption((o) => o.setName('want_item').setDescription('Item you want').setMaxLength(40))),
        new SlashCommandBuilder()
            .setName('games')
            .setDescription('Trivia, coinflip and rock-paper-scissors')
            .addSubcommand((s) => s.setName('trivia').setDescription('Start a trivia question in this channel'))
            .addSubcommand((s) => s.setName('coinflip').setDescription('Flip a coin'))
            .addSubcommand((s) => s.setName('rps').setDescription('Rock, paper, scissors against ZiGBoT')
                .addStringOption((o) => o.setName('choice').setDescription('Your pick').setRequired(true)
                    .addChoices({ name: 'Rock', value: 'rock' }, { name: 'Paper', value: 'paper' }, { name: 'Scissors', value: 'scissors' }))),
        new SlashCommandBuilder()
            .setName('giveaway')
            .setDescription('Staff: run giveaways')
            .addSubcommand((s) => s.setName('start').setDescription('Start a giveaway in this channel')
                .addStringOption((o) => o.setName('prize').setDescription('What can be won').setRequired(true).setMaxLength(200))
                .addIntegerOption((o) => o.setName('minutes').setDescription('How long it runs').setRequired(true).setMinValue(1).setMaxValue(43200))
                .addIntegerOption((o) => o.setName('winners').setDescription('How many winners (default 1)').setMinValue(1).setMaxValue(10))
                .addRoleOption((o) => o.setName('required_role').setDescription('Only members with this role can enter')))
            .addSubcommand((s) => s.setName('end').setDescription('End a giveaway now').addStringOption(messageId))
            .addSubcommand((s) => s.setName('reroll').setDescription('Pick new winners for an ended giveaway').addStringOption(messageId))
            .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
        new SlashCommandBuilder()
            .setName('tournament')
            .setDescription('Events and tournaments: sign-ups and brackets')
            .addSubcommand((s) => s.setName('create').setDescription('Staff: open sign-ups')
                .addStringOption((o) => o.setName('name').setDescription('Event name').setRequired(true).setMaxLength(100))
                .addIntegerOption((o) => o.setName('max_players').setDescription('2 to 32 (default 16)').setMinValue(2).setMaxValue(32)))
            .addSubcommand((s) => s.setName('start').setDescription('Staff: close sign-ups and post the bracket').addStringOption(messageId))
            .addSubcommand((s) => s.setName('win').setDescription('Staff: record a match winner').addStringOption(messageId)
                .addUserOption((o) => o.setName('player').setDescription('Who won the match').setRequired(true)))
            .addSubcommand((s) => s.setName('show').setDescription('Show the bracket').addStringOption(messageId))
    ];
}

function aiCommands() {
    return [
        new SlashCommandBuilder()
            .setName('ai')
            .setDescription('AI tools: translate, summarize, FAQ, moderation advice')
            .addSubcommand((s) => s.setName('translate').setDescription('Translate text')
                .addStringOption((o) => o.setName('text').setDescription('What to translate').setRequired(true).setMaxLength(1500))
                .addStringOption((o) => o.setName('to').setDescription('Target language, e.g. Hindi').setRequired(true).setMaxLength(30)))
            .addSubcommand((s) => s.setName('summarize').setDescription('Summarize the recent messages in this channel (only you see it)')
                .addIntegerOption((o) => o.setName('messages').setDescription('How many messages (5-100, default 50)').setMinValue(5).setMaxValue(100)))
            .addSubcommand((s) => s.setName('faq').setDescription('Ask the server FAQ')
                .addStringOption((o) => o.setName('question').setDescription('Your question').setRequired(true).setMaxLength(300)))
            .addSubcommand((s) => s.setName('modreview').setDescription('Staff: advisory suggestion for a moderation case')
                .addUserOption((o) => o.setName('member').setDescription('The member').setRequired(true))
                .addStringOption((o) => o.setName('situation').setDescription('What happened').setMaxLength(1000)))
    ];
}

/** Every optional-feature command, as builders (src/slash.js turns them into JSON). */
function featureCommandBuilders() {
    return [...communityCommands(), ...automationCommands(), ...engagementCommands(), ...aiCommands()];
}

module.exports = { featureCommandBuilders };
