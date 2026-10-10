/**
 * YouTube feature configuration. Reads env vars ONCE, never logs any of them,
 * and reports only WHICH vars are missing (names, never values) so startup
 * failures are debuggable without leaking secrets. The whole YouTube feature
 * is enabled or disabled as a unit: any missing credential disables it and the
 * Discord bot keeps running normally.
 */
const REQUIRED_FOR_ENABLE = [
    'YOUTUBE_CLIENT_ID',
    'YOUTUBE_CLIENT_SECRET',
    'YOUTUBE_REFRESH_TOKEN'
];

const DEFAULT_OWNER_HANDLE = '@YourBoyZiG';
const DEFAULT_QUOTA_BUDGET_PER_DAY = 10000;

function readYouTubeConfig(env = process.env) {
    const missing = REQUIRED_FOR_ENABLE.filter((name) => !env[name]);
    const number = (name, fallback, minimum = 0) => {
        if (env[name] === undefined || env[name] === null || env[name] === '') return fallback;
        const parsed = Number(env[name]);
        return Number.isFinite(parsed) ? Math.max(minimum, parsed) : fallback;
    };

    const autoDetectEnv = env.YOUTUBE_AUTO_DETECT;
    // The user chose: auto-detection defaults ON (cheap uploads-playlist poll),
    // YOUTUBE_AUTO_DETECT=false turns it off for manual-/watch-only operation.
    const autoDetect = autoDetectEnv === undefined || autoDetectEnv === null || autoDetectEnv === ''
        ? true
        : autoDetectEnv === 'true';

    return {
        enabled: missing.length === 0,
        missingVars: missing,
        clientIdPresent: Boolean(env.YOUTUBE_CLIENT_ID),
        clientSecretPresent: Boolean(env.YOUTUBE_CLIENT_SECRET),
        refreshTokenPresent: Boolean(env.YOUTUBE_REFRESH_TOKEN),
        ownerHandle: (env.YOUTUBE_OWNER_HANDLE || DEFAULT_OWNER_HANDLE).trim(),
        /** Optional hard override of the resolved owner channel ID. */
        ownerChannelIdOverride: (env.YOUTUBE_OWNER_CHANNEL_ID || '').trim() || null,
        /** Bot's own channel ID (the chatting/moderating identity), if the team provides one. */
        botChannelId: (env.YOUTUBE_BOT_CHANNEL_ID || '').trim() || null,
        autoDetect,
        autoDetectIntervalMs: Math.max(60_000, Number(env.YOUTUBE_DETECT_INTERVAL_MS) || 180_000),
        /** Optional "HH-HH" active-hours window (own server local time) for auto-detection. */
        activeHours: (env.YOUTUBE_ACTIVE_HOURS || '').trim() || null,
        /** Manual /watch override always allowed by default. */
        allowManualWatch: env.YOUTUBE_ALLOW_MANUAL_WATCH !== 'false',
        /** Daily quota safety cap (units). The monitor refuses work past this. */
        quotaBudgetPerDay: Math.max(0, Number(env.YOUTUBE_QUOTA_BUDGET) || DEFAULT_QUOTA_BUDGET_PER_DAY),
        greetingsEnabled: env.YOUTUBE_GREETINGS !== 'false',
        engagementPrompts: env.YOUTUBE_ENGAGEMENT_PROMPTS === 'true',
        ignoredChannelIds: String(env.YOUTUBE_IGNORE_CHANNEL_IDS || '').split(',').map((id) => id.trim()).filter(Boolean),
        botName: (env.YOUTUBE_BOT_NAME || 'ZiGBoT').trim(),
        quotaReserve: number('YOUTUBE_QUOTA_RESERVE', 2500),
        maxRepliesPerStream: number('YOUTUBE_MAX_REPLIES_PER_STREAM', 60),
        greetingMaxWords: number('YOUTUBE_GREETING_MAX_WORDS', 6, 1),
        backlogToleranceMs: number('YOUTUBE_BACKLOG_TOLERANCE_MS', 3000),
        outgoingIntervalMs: number('YOUTUBE_REPLY_INTERVAL_MS', 5000),
        maxPendingReplies: number('YOUTUBE_REPLY_QUEUE_MAX', 10, 1),
        mentionCooldownMs: number('YOUTUBE_MENTION_COOLDOWN_MS', 60_000),
        commandPrefix: (env.YOUTUBE_COMMAND_PREFIX || '!').trim() || '!',
        moderationEnabled: env.YOUTUBE_MODERATION !== 'false',
        moderationQuotaReserve: number('YOUTUBE_MOD_QUOTA_RESERVE', 400),
        maxModerationActionsPerStream: number('YOUTUBE_MAX_MOD_ACTIONS_PER_STREAM', 25),
        moderationActionCooldownMs: number('YOUTUBE_MOD_ACTION_COOLDOWN_MS', 2000),
        roastEnabled: env.YOUTUBE_ROAST !== 'false',
        roastMembers: env.YOUTUBE_ROAST_MEMBERS === 'true',
        maxRoastsPerStream: number('YOUTUBE_MAX_ROASTS_PER_STREAM', 25),
        roastIntervalMs: number('YOUTUBE_ROAST_INTERVAL_MS', 10_000),
        roastViewerCooldownMs: number('YOUTUBE_ROAST_VIEWER_COOLDOWN_MS', 120_000),
        roastAiTimeoutMs: number('YOUTUBE_ROAST_AI_TIMEOUT_MS', 8_000),
        roastAiRateLimitMax: number('YOUTUBE_ROAST_AI_RATE_LIMIT_MAX', 2, 1),
        roastAiRateLimitWindowMs: number('YOUTUBE_ROAST_AI_RATE_LIMIT_WINDOW_MS', 60_000, 1)
    };
}

/**
 * Is `now` inside the configured active-hours window? window is "HH-HH"
 * (24h local time, inclusive start, exclusive end). null/invalid window = always active.
 */
function withinActiveHours(activeHours, now = new Date()) {
    if (!activeHours) return true;
    const match = /^(\d{1,2})-(\d{1,2})$/.exec(activeHours);
    if (!match) return true;
    const start = Number(match[1]);
    const end = Number(match[2]);
    const hour = now.getHours();
    if (start === end) return true;
    if (start < end) return hour >= start && hour < end;
    return hour >= start || hour < end;
}

module.exports = { readYouTubeConfig, withinActiveHours, DEFAULT_OWNER_HANDLE, DEFAULT_QUOTA_BUDGET_PER_DAY };
