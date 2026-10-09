/**
 * YouTube orchestrator. Owns:
 *   - startup gating: only engage when YOUTUBE_* creds exist (Discord-safe)
 *   - owner-channel resolution at startup (cached)
 *   - manual /watch <videoId> and /unwatch ownership (owner-only, Discord side)
 *   - optional auto-detect loop
 *   - one active chat monitor at a time
 *
 * This module is designed so any process failure here can never take down
 * the Discord bot: every export is try/catch-safe at the caller, and the
 * bot keeps running normally when YouTube is unavailable.
 */
const {
    startChatMonitor
} = require('./chatMonitor');
const { startLiveDetector } = require('./liveDetector');
const { resolveOwnerChannel, resolveSelfChannel, _resetForTests } = require('./ownerChannel');
const YT_API = require('./apiClient');
const { readYouTubeConfig, withinActiveHours } = require('./config');

const state = {
    enabled: false,
    config: null,
    youtube: null,
    ownerId: null,
    selfId: null,
    watcher: null,       // active chat monitor
    detector: null,      // auto-detect loop
    lastWatchedVideoId: null,
    noticeLog: []
};

function log(message) {
    console.log(`[ZiGBoT YT] ${message}`);
}

function notice(message) {
    state.noticeLog.push({ at: new Date().toISOString(), message });
    log(message);
}

/**
 * Initialize YouTube support.
 * deps.youtube: pre-built youtube client for tests.
 * Returns the enabled state so the caller knows whether to wire /watch.
 */
async function initYouTube(youtubeConfigOverride = null, deps = {}) {
    const config = youtubeConfigOverride || readYouTubeConfig();

    if (!config.enabled) {
        state.enabled = false;
        state.config = config;
        log(`disabled, missing env vars: ${config.missingVars.join(', ')}`);
        return state;
    }

    state.config = config;
    if (deps.youtube) {
        state.youtube = deps.youtube;
    } else {
        state.youtube = YT_API.getYoutubeClient({
            clientId: process.env.YOUTUBE_CLIENT_ID,
            clientSecret: process.env.YOUTUBE_CLIENT_SECRET,
            refreshToken: process.env.YOUTUBE_REFRESH_TOKEN
        });
    }
    YT_API.setQuotaBudget(config.quotaBudgetPerDay);
    state.enabled = true;

    try {
        const owner = await resolveOwnerChannel(state.youtube, config);
        if (!owner) {
            notice(`owner channel could not be resolved from handle "${config.ownerHandle}". Disabling YouTube support.`);
            state.enabled = false;
            state.ownerId = null;
            return state;
        }
        state.ownerId = owner.id;
        log(`owner channel resolved: ${owner.id} (${owner.title}) [${owner.source}]`);

        state.selfId = (await resolveSelfChannel(state.youtube, config))?.id || null;
        if (!state.selfId) log("could not resolve bot's own channel ID; relying on authorDetails.isChatOwner/isChatModerator for self-filtering.");
        else log(`self channel: ${state.selfId}`);

        if (config.autoDetect) {
            state.detector = startLiveDetector({
                youtube: state.youtube,
                ownerId: state.ownerId,
                config,
                onLive: async ({ videoId, liveChatId, title }) => {
                    await watch({ videoId, liveChatId, title, via: 'auto-detect' });
                },
                onEnded: async () => { await stopWatcher('auto-detected stream ended'); },
                log
            });
        }
    } catch (error) {
        const kind = error?.yt?.kind || YT_API.classifyYouTubeError(error);
        notice(`startup failed (${kind}): ${error.message}. Disabling YouTube support; the Discord bot continues normally.`);
        state.enabled = false;
        return state;
    }

    return state;
}

/**
 * Watch a specific video's chat. Manual /watch path and auto-detect path
 * both land here. Refuses if already watching this video.
 */
async function watch({ videoId, liveChatId = null, title = '', via = 'manual' }) {
    if (!state.enabled || !state.youtube) return { ok: false, error: 'YouTube support is disabled.' };
    if (state.watcher && state.lastWatchedVideoId === videoId) {
        return { ok: true, already: true };
    }

    // Stop any previous watcher first — only one video at a time.
    await stopWatcher(`switching to ${via} watch of ${videoId}`);

    if (!liveChatId) {
        // 1 unit: get the active live-chat ID for this video.
        try {
            const videoRes = await YT_API.ytCall(
                state.youtube,
                (params) => state.youtube.videos.list(params),
                { part: 'liveStreamingDetails', id: videoId },
                { costUnits: 1, budget: state.config.quotaBudgetPerDay }
            );
            const details = videoRes?.data?.items?.[0]?.liveStreamingDetails;
            liveChatId = details?.activeLiveChatId || null;
            if (!liveChatId) {
                const message = `video ${videoId} has no active live chat (not live, or not a stream).`;
                notice(message);
                return { ok: false, error: message };
            }
        } catch (error) {
            const message = `failed to resolve live chat for ${videoId}: ${error.message}`;
            notice(message);
            return { ok: false, error: message };
        }
    }

    state.lastWatchedVideoId = videoId;
    state.watcher = startChatMonitor({
        youtube: state.youtube,
        videoId,
        liveChatId,
        config: state.config,
        onMessage: async (message) => {
            // Message handling is Phase 2/3/4; here we just prove the pipe.
            log(`chat ← ${message.author.displayName}: ${message.text}`);
        },
        onEnded: async () => {
            notice('stream ended (chat went offline).');
            stopWatcher('chat offline');
        },
        onNotice: (message) => notice(`watch ${videoId}: ${message}`)
    });

    log(`watching ${videoId} via ${via}${title ? ` (${title})` : ''}`);
    return { ok: true };
}

async function stopWatcher(reason = 'unspecified') {
    if (!state.watcher) return { stopped: false };
    const watcher = state.watcher;
    state.watcher = null;
    state.lastWatchedVideoId = null;
    watcher.stop();
    log(`stopped watcher: ${reason}`);
    return { stopped: true };
}

/** Manual /watch handler (owner-only gating is done by the Discord slash layer). */
async function handleWatchCommand(videoId, isOwnerDiscord) {
    if (!state.enabled) {
        return '❌ YouTube support is not enabled.';
    }
    if (!isOwnerDiscord) {
        return null; // non-owners: silently ignored, nobody learns the command exists
    }
    if (!videoId) {
        return '⚠️ Provide a videoId, e.g. `/watch jfKfPfyJRdk`.';
    }
    const result = await watch({ videoId, via: 'manual' });
    return result.ok ? `✅ Watching live chat for ${videoId}.` : `⚠️ ${result.error}`;
}

async function handleUnwatchCommand(isOwnerDiscord) {
    if (!state.enabled) return '❌ YouTube support is not enabled.';
    if (!isOwnerDiscord) return null; // silent non-owner ignore
    const result = await stopWatcher('owner /unwatch');
    return result.stopped ? '✅ Stopped watching YouTube chat.' : 'ℹ️ Nothing was being watched.';
}

/** True if the Discord-side /watch /unwatch commands should even be registered. */
function isYouTubeReady() {
    return state.enabled && Boolean(state.ownerId);
}

function getYouTubeStatus() {
    return {
        enabled: state.enabled,
        ownerId: state.ownerId,
        selfId: state.selfId,
        watching: state.watcher ? state.lastWatchedVideoId : null,
        autoDetect: Boolean(state.detector) && !state.detector.isDisabled(),
        quotaUsed: YT_API.quotaUsedToday(),
        quotaBudget: state.config?.quotaBudgetPerDay ?? null,
        quotaRemaining: YT_API.quotaRemaining(),
        notices: state.noticeLog.slice(-20)
    };
}

/** Test-only: reset in-memory module state. */
function _resetForTestHarness() {
    stopAll();
    state.noticeLog = [];
}

/**
 * Test-only: seed the module state directly (mock client, pre-resolved ids)
 * so tests can exercise watch/unwatch without network calls.
 */
function _seedStateForTests({ youtube = null, ownerId = null, selfId = null, config = null } = {}) {
    _resetForTestHarness();
    state.enabled = true;
    state.youtube = youtube;
    state.ownerId = ownerId;
    state.selfId = selfId;
    state.config = config || { quotaBudgetPerDay: 10_000, autoDetect: false, activeHours: null, autoDetectIntervalMs: 180_000 };
}

function stopAll() {
    if (state.watcher) stopWatcher('shutdown');
    if (state.detector) state.detector.stop();
    state.detector = null;
    state.enabled = false;
}

module.exports = {
    initYouTube,
    watch,
    handleWatchCommand,
    handleUnwatchCommand,
    isYouTubeReady,
    getYouTubeStatus,
    stopAll,
    _resetForTests: (...args) => { _resetForTests(...args); },
    _resetForTestHarness,
    _seedStateForTests,
    stateGetter: () => state,
    withinActiveHours
};
