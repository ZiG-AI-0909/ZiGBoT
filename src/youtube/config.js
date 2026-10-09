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
        quotaBudgetPerDay: Math.max(0, Number(env.YOUTUBE_QUOTA_BUDGET) || DEFAULT_QUOTA_BUDGET_PER_DAY)
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
