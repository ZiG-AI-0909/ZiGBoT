/**
 * Resolve and cache the owner's YouTube channel ID from their handle
 * (e.g. "@YourBoyZiG") via channels.list(forHandle). One unit per call; the
 * result is cached in-process so the resolve cost is paid only at startup.
 */
const YT_API = require('./apiClient');

let cachedChannel = null;

/**
 * Resolve the channel. YOUTUBE_OWNER_CHANNEL_ID override short-circuits the
 * network call entirely. Returns { id, title } or null on failure.
 */
async function resolveOwnerChannel(youtube, config) {
    if (config.ownerChannelIdOverride) {
        return { id: config.ownerChannelIdOverride, title: 'owner (config override)', source: 'override' };
    }
    if (cachedChannel) return cachedChannel;

    const handle = config.ownerHandle.startsWith('@') ? config.ownerHandle : `@${config.ownerHandle}`;
    const response = await YT_API.ytCall(
        youtube,
        (params) => youtube.channels.list(params),
        {
            part: 'id,snippet',
            forHandle: handle
        },
        { costUnits: 1, budget: config.quotaBudgetPerDay }
    );

    const item = response?.data?.items?.[0];
    if (!item) {
        return null;
    }
    cachedChannel = { id: item.id, title: item.snippet?.title || handle, source: 'handle' };
    return cachedChannel;
}

/**
 * Look up the bot's own channel ID (the identity whose OAuth token we hold)
 * so we do not reply to ourselves. Uses channels.list(mine=true) — 1 unit.
 */
async function resolveSelfChannel(youtube, config) {
    if (config.botChannelId) {
        return { id: config.botChannelId, source: 'config' };
    }
    try {
        const response = await YT_API.ytCall(
            youtube,
            (params) => youtube.channels.list(params),
            { part: 'id,snippet', mine: true },
            { costUnits: 1, budget: config.quotaBudgetPerDay }
        );
        const selfId = response?.data?.items?.[0]?.id || null;
        if (!selfId) return null;
        return { id: selfId, title: response?.data?.items?.[0]?.snippet?.title || null, source: 'mine' };
    } catch (error) {
        // Non-fatal: without a self-ID the greeting filter relies on
        // authorDetails.isChatModerator and the owner-ID exclusion instead.
        console.error(`[ZiGBoT YT] Could not resolve bot's own channel ID: ${error.message}`);
        return null;
    }
}

/** Test-only: forget the cached owner channel so a suite can re-resolve. */
function _resetForTests() {
    cachedChannel = null;
}

module.exports = { resolveOwnerChannel, resolveSelfChannel, _resetForTests };
