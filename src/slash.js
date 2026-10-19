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
const { isHomeGuild } = require('./guildConfig/store');
const {
    isYouTubeReady,
    getYouTubeStatus,
    handleWatchCommand,
    handleUnwatchCommand,
    handleYtGreetCommand,
    handleYtModCommand,
    handleYtRoastCommand,
    handleYtRetryCommand
} = require('./youtube');

// Only the highest-traffic actions get slash commands (per the roadmap);
// everything else stays on the text/voice path.
const slashActionByCommand = new Map([
    ['play', 'play'],
    ['search', 'search_music'],
    ['pause', 'pause_music'],
    ['resume', 'resume_music'],
    ['skip', 'skip_music'],
    ['stop', 'stop_music'],
    ['queue', 'queue_music'],
    ['nowplaying', 'now_playing'],
    ['volume', 'volume_music'],
    ['shuffle', 'shuffle_music'],
    ['loop', 'loop_music'],
    ['remove', 'remove_music'],
    ['clearqueue', 'clear_queue'],
    ['leave', 'leave_voice'],
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
            .setDescription('Play a song in your voice channel')
            .addStringOption((option) => option
                .setName('song')
                .setDescription('Song name, or a YouTube / SoundCloud link')
                .setMaxLength(500)
                .setRequired(true)),
        new SlashCommandBuilder()
            .setName('search')
            .setDescription('Search for a song and pick which result to play')
            .addStringOption((option) => option.setName('song').setDescription('Song name').setMaxLength(200).setRequired(true)),
        new SlashCommandBuilder().setName('pause').setDescription('Pause the music'),
        new SlashCommandBuilder().setName('resume').setDescription('Resume the music'),
        new SlashCommandBuilder().setName('skip').setDescription('Skip the current song'),
        new SlashCommandBuilder().setName('stop').setDescription('Stop the music and clear the queue'),
        new SlashCommandBuilder().setName('queue').setDescription('Show the current song and what plays next'),
        new SlashCommandBuilder().setName('nowplaying').setDescription('Show the song that is playing now'),
        new SlashCommandBuilder()
            .setName('volume')
            .setDescription('Set the music volume')
            .addIntegerOption((option) => option.setName('level').setDescription('1-100').setMinValue(1).setMaxValue(100).setRequired(true)),
        new SlashCommandBuilder().setName('shuffle').setDescription('Shuffle the upcoming songs'),
        new SlashCommandBuilder()
            .setName('loop')
            .setDescription('Loop the current song, the whole queue, or turn looping off')
            .addStringOption((option) => option.setName('mode').setDescription('What to loop').setRequired(true)
                .addChoices({ name: 'Current song', value: 'track' }, { name: 'Whole queue', value: 'queue' }, { name: 'Off', value: 'off' })),
        new SlashCommandBuilder()
            .setName('remove')
            .setDescription('Remove a song from the queue')
            .addIntegerOption((option) => option.setName('position').setDescription('Its number in /queue').setMinValue(1).setMaxValue(50).setRequired(true)),
        new SlashCommandBuilder().setName('clearqueue').setDescription('Clear the upcoming songs (the current one keeps playing)'),
        new SlashCommandBuilder().setName('leave').setDescription('Make ZiGBoT leave the voice channel'),
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
        new SlashCommandBuilder()
            .setName('setup')
            .setDescription('Admins: tell ZiGBoT the language, owner gender, and gender/age roles')
            .addStringOption((option) => option
                .setName('language')
                .setDescription('English (English humour) or Hinglish (desi humour)')
                .setRequired(true)
                .addChoices({ name: 'English', value: 'English' }, { name: 'Hinglish', value: 'Hinglish' }))
            .addStringOption((option) => option
                .setName('owner_gender')
                .setDescription("The server owner's gender")
                .setRequired(true)
                .addChoices(
                    { name: 'Male (he/him)', value: 'he/him' },
                    { name: 'Female (she/her)', value: 'she/her' },
                    { name: 'Prefer not to say (they/them)', value: 'they/them' }
                ))
            .addRoleOption((option) => option.setName('male_role').setDescription('Role that means male (he/him)'))
            .addRoleOption((option) => option.setName('female_role').setDescription('Role that means female (she/her)'))
            .addRoleOption((option) => option.setName('adult_role').setDescription('Role for members 18+ (roast mode)'))
            .addRoleOption((option) => option.setName('under18_role').setDescription('Role for members under 18 (always gentle, never roasted)'))
            .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
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
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
        new SlashCommandBuilder()
            .setName('ytretry')
            .setDescription('Owner: re-run YouTube initialization now (e.g. after a quota reset)')
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    ].map((command) => command.toJSON());
}

// YouTube is tied to the owner's personal channel: its commands are only
// registered in home servers, so other servers never even see them.
const YOUTUBE_COMMANDS = new Set(['watch', 'unwatch', 'ytstatus', 'ytgreet', 'ytmod', 'ytroast', 'ytretry']);

async function registerSlashCommands(client, settings) {
    const json = buildDefinitions();
    const general = json.filter((command) => !YOUTUBE_COMMANDS.has(command.name));
    const youtube = json.filter((command) => YOUTUBE_COMMANDS.has(command.name));
    if (settings.slashCommandGuildIds.length > 0) {
        for (const guildId of settings.slashCommandGuildIds) {
            const guild = client.guilds.cache.get(guildId);
            if (guild) await guild.commands.set(isHomeGuild(guild, settings) ? json : general).catch(() => {});
        }
        return;
    }
    await client.application.commands.set(general).catch(() => {});
    for (const guild of client.guilds.cache.values()) {
        if (isHomeGuild(guild, settings)) await guild.commands.set(youtube).catch(() => {});
    }
}

// Convert an interaction into the same intent shape the text path uses.
// Field validation still happens inside executeTool — never here.
async function interactionToIntent(interaction) {
    const action = slashActionByCommand.get(interaction.commandName);
    if (!action) return null;

    if (action === 'play') {
        return { action, target: interaction.options.getString('song', true).trim().slice(0, 2000) };
    }
    if (action === 'search_music') return { action, target: interaction.options.getString('song', true).trim().slice(0, 200) };
    if (action === 'volume_music') return { action, volume: interaction.options.getInteger('level', true) };
    if (action === 'loop_music') return { action, loop: interaction.options.getString('mode', true) };
    if (action === 'remove_music') return { action, position: interaction.options.getInteger('position', true) };
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
            const quotaMethods = Object.entries(status.quotaMethods || {})
                .map(([method, usage]) => `${method}: ${usage.calls} calls/${usage.units} units`).join(', ') || 'none';
            const quotaState = status.quotaWaiting
                ? `waiting for quota reset (retry ${status.quotaRetryAt || 'scheduled'})`
                : 'ok';
            return [
                `enabled: ${status.enabled}`,
                `quota state: ${quotaState}`,
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
                `quota used today: ${status.quotaUsed}/${status.quotaBudget ?? 'unknown'}`,
                `quota methods: ${quotaMethods}`
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
        if (interaction.commandName === 'ytretry') {
            return await handleYtRetryCommand(true);
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
    YOUTUBE_COMMANDS,
    runYouTubeInteraction
};
