/**
 * Shared ZiGBoT multi-server constants.
 *
 * This file is CommonJS on purpose: it is `require`d by the Discord bot
 * (Node, CommonJS) AND imported by the Next.js dashboard, so validation and
 * permission rules can never drift between the two.
 */

// Features a role mapping can allow or deny. Features only ever RESTRICT what
// the bot will do for someone; they can never grant a Discord permission.
const FEATURES = Object.freeze({
    chat: 'Talk to the AI (mentions, replies, chat channels)',
    roast: 'Savage/roast persona and comebacks',
    memory: 'Long-term memory recall for this member',
    music: 'Music playback commands',
    voice: 'Voice channel join / listening',
    moderation: 'Moderation tools (warn, timeout, kick, ban, purge) — still needs the real Discord permission',
    admin_tools: 'Server-management tools (roles, channels, announcements, diagnostics) — still needs the real Discord permission'
});
const FEATURE_KEYS = Object.freeze(Object.keys(FEATURES));

// Features everyone gets unless a mapping denies them.
const DEFAULT_MEMBER_FEATURES = Object.freeze(['chat', 'music', 'voice', 'memory']);

const TONES = Object.freeze(['gentle', 'savage', 'neutral']);
// How hard Savage mode roasts (dashboard + /setup). Hard limits apply at
// every level; only 'savage' allows mild profanity (lib/shared/roast.js).
const ROAST_INTENSITIES = Object.freeze(['mild', 'spicy', 'savage']);
const DEFAULT_ROAST_INTENSITY = 'spicy';
const TIERS = Object.freeze(['admin', 'moderator', 'member', 'custom']);
const PRONOUNS = Object.freeze(['she/her', 'he/him', 'they/them']);
const RESPONSE_LENGTHS = Object.freeze(['short', 'medium', 'long']);

const LIMITS = Object.freeze({
    customSystemPrompt: 4000,
    responseInstructions: 2000,
    serverRules: 2000,
    language: 60,
    responseStyle: 300,
    roleInstructions: 1000,
    roleMappingsPerGuild: 50,
    channelsPerList: 100,
    cooldownMin: 0,
    cooldownMax: 3600,
    priorityMin: -1000,
    priorityMax: 1000,
    previewMessage: 1000
});

// Bot tool action -> feature that gates it. Actions not listed are ungated
// informational actions (help, server info, ...).
const ACTION_FEATURES = Object.freeze({
    send_message: 'admin_tools',
    create_role: 'admin_tools',
    delete_role: 'admin_tools',
    add_role: 'admin_tools',
    remove_role: 'admin_tools',
    create_channel: 'admin_tools',
    delete_channel: 'admin_tools',
    rename_channel: 'admin_tools',
    memory_status: 'admin_tools',
    behavior_status: 'admin_tools',
    timeout_member: 'moderation',
    kick_member: 'moderation',
    ban_member: 'moderation',
    unban_member: 'moderation',
    delete_messages: 'moderation',
    warn_member: 'moderation',
    list_warnings: 'moderation',
    start_voice_listening: 'voice',
    stop_voice_listening: 'voice',
    join_voice: 'voice',
    leave_voice: 'voice',
    play: 'music',
    pause_music: 'music',
    resume_music: 'music',
    skip_music: 'music',
    stop_music: 'music',
    queue_music: 'music',
    now_playing: 'music',
    volume_music: 'music',
    loop_music: 'music',
    search_music: 'music',
    shuffle_music: 'music',
    remove_music: 'music',
    clear_queue: 'music'
});

// Discord permission bits (as BigInt) used by the backend checks.
const PERMISSIONS = Object.freeze({
    ADMINISTRATOR: 1n << 3n,
    MANAGE_GUILD: 1n << 5n,
    KICK_MEMBERS: 1n << 1n,
    BAN_MEMBERS: 1n << 2n,
    MANAGE_CHANNELS: 1n << 4n,
    MANAGE_MESSAGES: 1n << 13n,
    MANAGE_ROLES: 1n << 28n,
    MODERATE_MEMBERS: 1n << 40n
});

const CONFIG_CACHE_TTL_MS = 30_000;

// Sarvam Bulbul v3 voices (lowercase ids). '' = the bot's default voice.
const VOICE_SPEAKERS = Object.freeze([
    'shubh', 'aditya', 'ritu', 'priya', 'neha', 'rahul', 'pooja', 'rohan', 'simran', 'kavya',
    'amit', 'dev', 'ishita', 'shreya', 'ratan', 'varun', 'manan', 'sumit', 'roopa', 'kabir',
    'aayan', 'ashutosh', 'advait', 'anand', 'tanya', 'tarun', 'sunny', 'mani', 'gokul', 'vijay',
    'shruti', 'suhani', 'mohit', 'kavitha', 'rehan', 'soham', 'rupali'
]);
const VOICE_LANGUAGES = Object.freeze(['auto', 'hi-IN', 'en-IN']);

module.exports = {
    FEATURES,
    FEATURE_KEYS,
    DEFAULT_MEMBER_FEATURES,
    TONES,
    ROAST_INTENSITIES,
    DEFAULT_ROAST_INTENSITY,
    TIERS,
    PRONOUNS,
    RESPONSE_LENGTHS,
    LIMITS,
    ACTION_FEATURES,
    PERMISSIONS,
    CONFIG_CACHE_TTL_MS,
    VOICE_SPEAKERS,
    VOICE_LANGUAGES
};
