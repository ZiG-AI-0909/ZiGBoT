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
const { hasDirtyLanguage, getPlayfulRoast } = require('./chatModeration');
const { Greetings } = require('./greetings');
const { YouTubeCommandRouter } = require('./commands');
const brain = require('../db/brain');

const state = {
    enabled: false,
    config: null,
    youtube: null,
    ownerId: null,
    selfId: null,
    watcher: null,       // active chat monitor
    detector: null,      // auto-detect loop
    lastWatchedVideoId: null,
    noticeLog: [],
    greetings: null,
    greetingContext: null,
    botTitle: null,
    moderation: null,
    discordClient: null,
    discordSettings: null
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
    state.discordClient = deps.discordClient || null;
    state.discordSettings = deps.settings || { logChannelId: process.env.LOG_CHANNEL_ID || '' };
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

        const self = await resolveSelfChannel(state.youtube, config);
        state.selfId = self?.id || null;
        state.botTitle = self?.title || config.botName || 'ZiGBoT';
        if (!state.selfId) log("could not resolve bot's own channel ID; relying on authorDetails.isChatOwner/isChatModerator for self-filtering.");
        else log(`self channel: ${state.selfId}`);

        if (config.autoDetect) {
            const discordIds = () => ({
                channelId: process.env.YOUTUBE_DISCORD_CHANNEL_ID || '1366908121754239009',
                roleId: process.env.YOUTUBE_DISCORD_ROLE_ID || '1366912959510478868'
            });
            const postDiscordNotice = async (content) => {
                if (!deps.discordClient) return;
                const { channelId, roleId } = discordIds();
                try {
                    const channel = await deps.discordClient.channels.fetch(channelId);
                    if (!channel?.isTextBased?.()) {
                        log(`live notification skipped: Discord channel ${channelId} is unavailable or not text-based.`);
                        return;
                    }
                    await channel.send({
                        content: `<@&${roleId}> ${content}`,
                        allowedMentions: { roles: [roleId] }
                    });
                } catch (error) {
                    log(`live notification failed: ${error.message}`);
                }
            };
            state.detector = startLiveDetector({
                youtube: state.youtube,
                ownerId: state.ownerId,
                config,
                onLive: async ({ videoId, liveChatId, title }) => {
                    await postDiscordNotice(`We’re live on YouTube! https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`);
                    await watch({ videoId, liveChatId, title, via: 'auto-detect' });
                },
                onScheduled: async ({ videoId, title, scheduledStartTime }) => {
                    const scheduledDate = new Date(scheduledStartTime);
                    if (Number.isNaN(scheduledDate.getTime())) return;
                    const when = new Intl.DateTimeFormat(undefined, {
                        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
                        hour: 'numeric', minute: '2-digit', timeZoneName: 'short'
                    }).format(scheduledDate);
                    const label = title ? `**${title}**` : 'A YouTube live stream';
                    await postDiscordNotice(`${label} is scheduled for **${when}**. https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`);
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
    state.greetingContext = { videoId, liveChatId };
    state.greetings = new Greetings({ youtube: state.youtube, liveChatId, videoId, config: state.config,
        selfId: state.selfId, ownerId: state.ownerId, botTitle: state.botTitle, brain,
        onNotice: (message) => notice(`watch ${videoId}: ${message}`) });
    state.moderation = new YouTubeCommandRouter({ youtube: state.youtube, videoId, liveChatId,
        ownerId: state.ownerId, selfId: state.selfId, botTitle: state.botTitle, config: state.config, greetings: state.greetings,
        brain, discordClient: state.discordClient, settings: state.discordSettings,
        onNotice: (message) => notice(`watch ${videoId}: ${message}`) });
    const timedOutUsers = new Set();
    const roastCooldowns = new Map();
    state.watcher = startChatMonitor({
        youtube: state.youtube,
        videoId,
        liveChatId,
        config: state.config,
        onMessage: async (message) => {
            if (state.moderation && await state.moderation.handleMessage(message)) return;
            const author = message.author;
            if (!author?.channelId || author.channelId === state.ownerId || author.channelId === state.selfId
                || author.isChatOwner || author.isChatModerator) return;

            if (state.greetings?.enabled) {
                await state.greetings.handle(message);
            }

            if (hasDirtyLanguage(message.text)) {
                if (timedOutUsers.has(author.channelId)) return;
                timedOutUsers.add(author.channelId);
                try {
                    await YT_API.ytCall(
                        state.youtube,
                        (params) => state.youtube.liveChatBans.insert(params),
                        {
                            part: 'snippet',
                            requestBody: {
                                snippet: {
                                    liveChatId,
                                    type: 'temporary',
                                    banDurationSeconds: 300,
                                    bannedUserDetails: { channelId: author.channelId }
                                }
                            }
                        },
                        { costUnits: 200, budget: state.config.quotaBudgetPerDay }
                    );
                    notice(`timed out YouTube chatter ${author.channelId} for 5 minutes (dirty language).`);
                } catch (error) {
                    notice(`could not time out YouTube chatter ${author.channelId}: ${error.message}. Check that the bot is a live-chat moderator.`);
                }
                return;
            }

            const roast = getPlayfulRoast(message.text);
            if (state.config.greetingsEnabled) return;
            if (!roast || Date.now() - (roastCooldowns.get(author.channelId) || 0) < 60_000) return;
            roastCooldowns.set(author.channelId, Date.now());
            try {
                await YT_API.ytCall(
                    state.youtube,
                    (params) => state.youtube.liveChatMessages.insert(params),
                    {
                        part: 'snippet',
                        requestBody: {
                            snippet: {
                                liveChatId,
                                type: 'textMessageEvent',
                                textMessageDetails: { messageText: roast }
                            }
                        }
                    },
                    { costUnits: 20, budget: state.config.quotaBudgetPerDay }
                );
            } catch (error) {
                notice(`could not post YouTube chat roast: ${error.message}`);
            }
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
    watcher.stop();
    const moderation = state.moderation;
    state.moderation = null;
    if (moderation) await moderation.stop();
    state.greetings?.stop();
    state.greetings = null;
    state.greetingContext = null;
    state.lastWatchedVideoId = null;
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

async function handleYtGreetCommand(value, isOwnerDiscord) {
    if (!state.enabled) return '❌ YouTube support is not enabled.';
    if (!isOwnerDiscord) return null;
    const normalized = String(value || '').trim().toLowerCase();
    if (!['on', 'off'].includes(normalized)) return '⚠️ Use `/ytgreet on` or `/ytgreet off`.';
    if (normalized === 'on' && state.greetings?.disabledNotice) {
        return '⚠️ Greetings were disabled after a YouTube send error; they can resume on the next stream.';
    }
    state.config.greetingsEnabled = normalized === 'on';
    if (state.greetings) {
        state.greetings.setGreetingsEnabled(state.config.greetingsEnabled);
    } else if (state.config.greetingsEnabled && state.greetingContext) {
        state.greetings = new Greetings({ youtube: state.youtube, ...state.greetingContext,
            config: state.config, selfId: state.selfId, ownerId: state.ownerId,
            botTitle: state.botTitle, brain, onNotice: (message) => notice(message) });
    }
    return `✅ YouTube greetings ${normalized === 'on' ? 'enabled' : 'disabled'}.`;
}

async function handleYtModCommand(value, isOwnerDiscord) {
    if (!state.enabled) return '❌ YouTube support is not enabled.';
    if (!isOwnerDiscord) return null;
    const normalized = String(value || '').trim().toLowerCase();
    if (!['on', 'off'].includes(normalized)) return '⚠️ Use `/ytmod on` or `/ytmod off`.';
    state.config.moderationEnabled = normalized === 'on';
    if (state.moderation) {
        await state.moderation.setEnabled(state.config.moderationEnabled, { allowForbiddenRecovery: normalized === 'on' });
    }
    return `✅ YouTube moderation ${normalized === 'on' ? 'enabled' : 'disabled'}.`;
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
        greetings: state.greetings ? state.greetings.enabled : Boolean(state.config?.greetingsEnabled),
        repliesSent: state.greetings?.repliesSent || 0,
        moderation: state.moderation ? state.moderation.active : Boolean(state.config?.moderationEnabled),
        moderationActions: state.moderation?.actionsUsed || 0,
        notices: state.noticeLog.slice(-20)
    };
}

/** Test-only: reset in-memory module state. */
function _resetForTestHarness() {
    stopAll();
    state.moderation = null;
    state.greetings?.stop();
    state.greetings = null;
    state.greetingContext = null;
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
    state.moderation = null;
    state.discordClient = null;
    state.discordSettings = null;
}

function stopAll() {
    if (state.watcher) stopWatcher('shutdown');
    else if (state.moderation) {
        void state.moderation.stop();
        state.moderation = null;
        state.greetings?.stop();
        state.greetings = null;
    }
    if (state.detector) state.detector.stop();
    state.detector = null;
    state.enabled = false;
}

module.exports = {
    initYouTube,
    watch,
    handleWatchCommand,
    handleUnwatchCommand,
    handleYtGreetCommand,
    handleYtModCommand,
    isYouTubeReady,
    getYouTubeStatus,
    stopAll,
    _resetForTests: (...args) => { _resetForTests(...args); },
    _resetForTestHarness,
    _seedStateForTests,
    stateGetter: () => state,
    withinActiveHours
};
