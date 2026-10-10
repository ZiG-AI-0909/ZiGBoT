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
const { RateLimiter } = require('../ai/rateLimiter');
const brain = require('../db/brain');

// Quota exhaustion is temporary, so init is retried just after the next
// Pacific reset instead of leaving YouTube dead for the process lifetime.
const QUOTA_RETRY_MARGIN_MS = 2 * 60_000;
const QUOTA_RETRY_JITTER_MS = 60_000;
const MIN_QUOTA_RETRY_DELAY_MS = 1_000;

const state = {
    enabled: false,
    config: null,
    youtube: null,
    ownerId: null,
    selfId: null,
    watcher: null,       // active chat monitor
    watcherLiveChatId: null,
    watchTail: Promise.resolve(),
    detector: null,      // auto-detect loop
    lastWatchedVideoId: null,
    noticeLog: [],
    greetings: null,
    greetingContext: null,
    botTitle: null,
    moderation: null,
    discordClient: null,
    discordSettings: null,
    ai: null,
    quotaWaiting: false, // paused because the daily quota is spent
    quotaRetryAt: null,  // Date of the scheduled post-reset retry
    quotaRetryTimer: null,
    quotaRetryAttempts: 0,
    lastInitError: null, // { kind, message, at } of the last failed init
    runtime: null        // deps captured at init so retries can reuse them
};

function log(message) {
    console.log(`[ZiGBoT YT] ${message}`);
}

function notice(message) {
    state.noticeLog.push({ at: new Date().toISOString(), message });
    log(message);
}

/**
 * Cancel a pending post-quota-reset retry (manual /ytretry, shutdown, or a
 * fresh init that is about to schedule its own).
 */
function clearQuotaRetry() {
    if (state.quotaRetryTimer) {
        const clear = state.runtime?.clearTimer || clearTimeout;
        try { clear(state.quotaRetryTimer); } catch { /* timer already gone */ }
    }
    state.quotaRetryTimer = null;
    state.quotaRetryAt = null;
}

/**
 * Schedule one init retry just after the next midnight-Pacific reset (2 minute
 * margin plus jitter). Only one retry is ever pending, so a burst of quota
 * errors cannot stack timers or loop.
 */
function scheduleQuotaRetry(reason) {
    const runtime = state.runtime || {};
    const now = typeof runtime.now === 'function' ? runtime.now : () => new Date();
    if (state.quotaRetryTimer) return state.quotaRetryAt;
    const random = typeof runtime.random === 'function' ? runtime.random : Math.random;
    const jitterMs = Math.round(Math.max(0, Math.min(1, Number(random()) || 0)) * QUOTA_RETRY_JITTER_MS);
    const retryAt = YT_API.nextQuotaResetAt(now(), { marginMs: QUOTA_RETRY_MARGIN_MS, jitterMs });
    const delayMs = Math.max(MIN_QUOTA_RETRY_DELAY_MS, retryAt.getTime() - now().getTime());
    const setTimer = typeof runtime.setTimer === 'function' ? runtime.setTimer : setTimeout;
    state.quotaRetryAt = retryAt;
    const timer = setTimer(() => {
        state.quotaRetryTimer = null;
        return retryInitAfterQuotaReset();
    }, delayMs);
    // The Discord client keeps the process alive; a retry timer must not.
    if (timer && typeof timer.unref === 'function') timer.unref();
    state.quotaRetryTimer = timer;
    notice(`YouTube quota unavailable (${reason}); calls paused, retrying initialization at ${retryAt.toISOString()} (Pacific reset + ${QUOTA_RETRY_MARGIN_MS / 60_000}min).`);
    return retryAt;
}

/**
 * Pause YouTube because the daily quota is spent, and schedule the retry.
 * Unlike an auth/forbidden failure this is NOT permanent, so YouTube is left
 * "waiting for quota reset" rather than disabled for the process lifetime.
 */
function enterQuotaWait(reason) {
    state.enabled = false;
    state.quotaWaiting = true;
    scheduleQuotaRetry(reason);
    return state;
}

/** The scheduled retry: re-runs init so the new PT day hydrates at zero. */
async function retryInitAfterQuotaReset() {
    state.quotaRetryTimer = null;
    state.quotaRetryAttempts += 1;
    log(`retrying YouTube initialization after the Pacific quota reset (attempt ${state.quotaRetryAttempts}).`);
    try {
        await initYouTube(state.runtime?.config || null, state.runtime || {});
    } catch (error) {
        // initYouTube never throws, but a retry must never take the process down.
        notice(`quota-reset retry failed: ${error.message}`);
        enterQuotaWait(`retry error: ${error.message}`);
        return state;
    }
    if (state.quotaWaiting) log('quota still exhausted after the retry; YouTube stays paused until the next reset.');
    else log('quota reset retry re-enabled YouTube support.');
    return state;
}

/** Friendly "why can't I /watch" line; distinguishes waiting-for-quota. */
function notEnabledReply() {
    if (state.quotaWaiting) {
        return `⏳ YouTube calls are paused until the daily quota resets${state.quotaRetryAt ? ` (retry scheduled for ${state.quotaRetryAt.toISOString()})` : ''}.`;
    }
    return '❌ YouTube support is not enabled.';
}

/**
 * Initialize YouTube support.
 * deps.youtube: pre-built youtube client for tests.
 * Returns the enabled state so the caller knows whether to wire /watch.
 */
async function initYouTube(youtubeConfigOverride = null, deps = {}) {
    await stopWatcher('YouTube reinitialization');
    if (state.detector) state.detector.stop();
    state.detector = null;
    clearQuotaRetry();
    state.quotaWaiting = false;
    // `deps.config` carries the original override through a scheduled retry so
    // the re-init uses exactly the config the first attempt was given.
    const config = youtubeConfigOverride || deps.config || readYouTubeConfig();

    if (!config.enabled) {
        state.enabled = false;
        state.config = config;
        log(`disabled, missing env vars: ${config.missingVars.join(', ')}`);
        return state;
    }

    // Capture the dependencies so the post-quota-reset retry and /ytretry can
    // re-run init without the caller passing them again.
    state.runtime = {
        youtube: deps.youtube || null,
        discordClient: deps.discordClient || null,
        settings: deps.settings || { logChannelId: process.env.LOG_CHANNEL_ID || '' },
        ai: deps.ai || null,
        brain: deps.brain || null,
        config: youtubeConfigOverride || deps.config || null,
        setTimer: typeof deps.setTimer === 'function' ? deps.setTimer : setTimeout,
        clearTimer: typeof deps.clearTimer === 'function' ? deps.clearTimer : clearTimeout,
        now: typeof deps.now === 'function' ? deps.now : () => new Date(),
        random: typeof deps.random === 'function' ? deps.random : Math.random
    };

    state.config = config;
    state.discordClient = state.runtime.discordClient;
    state.discordSettings = state.runtime.settings;
    state.ai = state.runtime.ai;
    if (state.runtime.youtube) {
        state.youtube = state.runtime.youtube;
    } else {
        state.youtube = YT_API.getYoutubeClient({
            clientId: process.env.YOUTUBE_CLIENT_ID,
            clientSecret: process.env.YOUTUBE_CLIENT_SECRET,
            refreshToken: process.env.YOUTUBE_REFRESH_TOKEN
        });
    }
    // `deps.brain` is a test seam; production always uses the Mongo-backed one.
    const quotaBrain = state.runtime.brain || brain;
    YT_API.setQuotaBudget(config.quotaBudgetPerDay);
    YT_API.configureQuotaLedger({ brain: quotaBrain, onNotice: (message) => notice(message) });
    await YT_API.hydrateQuotaLedger();

    // An already-spent ledger (persisted by an earlier run of this PT day) must
    // not disable YouTube forever: wait for the reset instead.
    if (YT_API.quotaExhausted()) {
        enterQuotaWait(`daily quota already spent (${YT_API.quotaUsedToday()}/${config.quotaBudgetPerDay} units)`);
        return state;
    }
    state.enabled = true;
    state.quotaWaiting = false;
    state.quotaRetryAttempts = 0;
    state.lastInitError = null;

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
                onQuotaExhausted: async (reason) => {
                    await stopWatcher('quota exhausted during auto-detection');
                    enterQuotaWait(`auto-detection hit the quota limit: ${reason}`);
                },
                log
            });
        }
    } catch (error) {
        const kind = error?.yt?.kind || YT_API.classifyYouTubeError(error);
        state.lastInitError = { kind, message: error.message, at: new Date().toISOString() };
        if (kind === YT_API.KIND.QUOTA) {
            // Temporary by definition: keep the process alive and retry right
            // after the Pacific reset. Auth/forbidden failures still disable
            // YouTube for good and are never retried in a loop.
            enterQuotaWait(`init hit the quota limit: ${error.message}`);
            return state;
        }
        notice(`startup failed (${kind}): ${error.message}. Disabling YouTube support; the Discord bot continues normally.`);
        state.enabled = false;
        state.quotaWaiting = false;
        clearQuotaRetry();
        return state;
    }

    return state;
}

/**
 * Watch a specific video's chat. Manual /watch path and auto-detect path
 * both land here. Refuses if already watching this video.
 */
function watch(options) {
    const run = state.watchTail.then(() => watchInternal(options));
    state.watchTail = run.catch(() => {});
    return run;
}

async function watchInternal({ videoId, liveChatId = null, title = '', via = 'manual' }) {
    if (!state.enabled || !state.youtube) return { ok: false, error: 'YouTube support is disabled.' };
    if (state.watcher && state.lastWatchedVideoId === videoId) {
        return { ok: true, already: true };
    }

    if (!liveChatId) {
        // 1 unit: get the active live-chat ID for this video.
        try {
            const videoRes = await YT_API.ytCall(
                state.youtube,
                (params) => state.youtube.videos.list(params),
                { part: 'liveStreamingDetails', id: videoId },
                { costUnits: 1, budget: state.config.quotaBudgetPerDay, method: 'videos.list' }
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

    if (state.watcher && state.watcherLiveChatId === liveChatId) {
        return { ok: true, already: true };
    }

    // A queued manual /watch and auto-detect callback can arrive together;
    // this serialized path stops the old loop before installing the new one.
    await stopWatcher(`switching to ${via} watch of ${videoId}`);
    state.lastWatchedVideoId = videoId;
    state.watcherLiveChatId = liveChatId;
    state.greetingContext = { videoId, liveChatId };
    state.greetings = new Greetings({ youtube: state.youtube, liveChatId, videoId, config: state.config,
        selfId: state.selfId, ownerId: state.ownerId, botTitle: state.botTitle, brain: state.runtime?.brain || brain,
        onNotice: (message) => notice(`watch ${videoId}: ${message}`) });
    state.moderation = new YouTubeCommandRouter({ youtube: state.youtube, videoId, liveChatId,
        ownerId: state.ownerId, selfId: state.selfId, botTitle: state.botTitle, config: state.config, greetings: state.greetings,
        brain: state.runtime?.brain || brain, discordClient: state.discordClient, settings: state.discordSettings, ai: state.ai,
        roastRateLimiter: new RateLimiter({ max: state.config.roastAiRateLimitMax || 2,
            windowMs: state.config.roastAiRateLimitWindowMs || 60_000 }),
        onNotice: (message) => notice(`watch ${videoId}: ${message}`) });
    state.greetings.roastMode = state.moderation.roast;
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
                        { costUnits: 200, budget: state.config.quotaBudgetPerDay, method: 'liveChatBans.insert' }
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
                    { costUnits: 20, budget: state.config.quotaBudgetPerDay, method: 'liveChatMessages.insert' }
                );
            } catch (error) {
                notice(`could not post YouTube chat roast: ${error.message}`);
            }
        },
        onQuotaExhausted: async () => {
            // Quota ran out mid-stream: stop the calls, keep the process alive,
            // and re-initialize right after the Pacific reset.
            await stopWatcher('quota exhausted mid-stream');
            enterQuotaWait('daily quota exhausted while watching live chat');
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
    state.watcherLiveChatId = null;
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
        return notEnabledReply();
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
    if (!state.enabled) return notEnabledReply();
    if (!isOwnerDiscord) return null; // silent non-owner ignore
    const result = await stopWatcher('owner /unwatch');
    return result.stopped ? '✅ Stopped watching YouTube chat.' : 'ℹ️ Nothing was being watched.';
}

async function handleYtGreetCommand(value, isOwnerDiscord) {
    if (!state.enabled) return notEnabledReply();
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
            botTitle: state.botTitle, brain: state.runtime?.brain || brain, onNotice: (message) => notice(message) });
    }
    return `✅ YouTube greetings ${normalized === 'on' ? 'enabled' : 'disabled'}.`;
}

async function handleYtModCommand(value, isOwnerDiscord) {
    if (!state.enabled) return notEnabledReply();
    if (!isOwnerDiscord) return null;
    const normalized = String(value || '').trim().toLowerCase();
    if (!['on', 'off'].includes(normalized)) return '⚠️ Use `/ytmod on` or `/ytmod off`.';
    state.config.moderationEnabled = normalized === 'on';
    if (state.moderation) {
        await state.moderation.setEnabled(state.config.moderationEnabled, { allowForbiddenRecovery: normalized === 'on' });
    }
    return `✅ YouTube moderation ${normalized === 'on' ? 'enabled' : 'disabled'}.`;
}

async function handleYtRoastCommand(value, isOwnerDiscord) {
    if (!state.enabled) return notEnabledReply();
    if (!isOwnerDiscord) return null;
    if (state.config?.roastEnabled === false) return '⚠️ YouTube roast commands are disabled by YOUTUBE_ROAST.';
    const normalized = String(value || '').trim().toLowerCase();
    if (!['on', 'off', 'status'].includes(normalized)) return '⚠️ Use `/ytroast on`, `/ytroast off`, or `/ytroast status`.';
    if (normalized === 'status') {
        const roast = state.moderation?.roast;
        return `✅ YouTube roast mode ${roast?.mode ? 'on' : 'off'}; ${roast?.roastsSent || 0} roasts sent and ${roast?.aiCalls || 0} AI calls this stream.`;
    }
    if (!state.moderation?.roast) return '⚠️ Start watching a stream before changing roast mode.';
    state.moderation.roast.mode = normalized === 'on';
    return `✅ YouTube roast mode ${normalized} for this stream.`;
}

/**
 * Manual /ytretry: re-run initialization on demand (owner-only, gated by the
 * slash layer the same way as every other YouTube command).
 */
async function handleYtRetryCommand(isOwnerDiscord) {
    if (!isOwnerDiscord) return null; // silent non-owner ignore
    clearQuotaRetry();
    state.quotaWaiting = false;
    const result = await initYouTube(state.runtime?.config || null, state.runtime || {});
    if (result.quotaWaiting) {
        return `⏳ YouTube is still out of quota; next automatic retry at ${result.quotaRetryAt ? result.quotaRetryAt.toISOString() : 'the Pacific reset'}.`;
    }
    if (!result.enabled) {
        return `❌ YouTube re-initialization failed (${result.lastInitError?.kind || 'not configured'}); check the server logs.`;
    }
    return `✅ YouTube re-initialized (auto-detect ${result.detector ? 'on' : 'off'}).`;
}

/** True if the Discord-side /watch /unwatch commands should even be registered. */
function isYouTubeReady() {
    return state.enabled && Boolean(state.ownerId);
}

function getYouTubeStatus() {
    return {
        enabled: state.enabled,
        quotaWaiting: Boolean(state.quotaWaiting),
        quotaRetryAt: state.quotaRetryAt ? state.quotaRetryAt.toISOString() : null,
        quotaRetryAttempts: state.quotaRetryAttempts,
        lastInitError: state.lastInitError,
        ownerId: state.ownerId,
        selfId: state.selfId,
        watching: state.watcher ? state.lastWatchedVideoId : null,
        autoDetect: Boolean(state.detector) && !state.detector.isDisabled(),
        quotaUsed: YT_API.quotaUsedToday(),
        quotaBudget: state.config?.quotaBudgetPerDay ?? null,
        quotaRemaining: YT_API.quotaRemaining(),
        quotaMethods: YT_API.quotaMethodUsage(),
        greetings: state.greetings ? state.greetings.enabled : Boolean(state.config?.greetingsEnabled),
        repliesSent: state.greetings?.repliesSent || 0,
        messagesSent: state.greetings?.messagesSent || 0,
        moderation: state.moderation ? state.moderation.active : Boolean(state.config?.moderationEnabled),
        moderationActions: state.moderation?.actionsUsed || 0,
        roastMode: Boolean(state.moderation?.roast?.mode),
        roastsSent: state.moderation?.roast?.roastsSent || 0,
        roastAiCalls: state.moderation?.roast?.aiCalls || 0,
        notices: state.noticeLog.slice(-20)
    };
}

/** Test-only: reset in-memory module state. */
function _resetForTestHarness() {
    stopAll();
    state.moderation = null;
    state.watcherLiveChatId = null;
    state.watchTail = Promise.resolve();
    state.greetings?.stop();
    state.greetings = null;
    state.greetingContext = null;
    state.noticeLog = [];
    state.quotaWaiting = false;
    state.quotaRetryAttempts = 0;
    state.lastInitError = null;
    state.runtime = null;
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
    state.watcherLiveChatId = null;
}

function stopAll() {
    clearQuotaRetry();
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
    handleYtRoastCommand,
    handleYtRetryCommand,
    retryInitAfterQuotaReset,
    isYouTubeReady,
    getYouTubeStatus,
    stopAll,
    _resetForTests: (...args) => { _resetForTests(...args); },
    _resetForTestHarness,
    _seedStateForTests,
    stateGetter: () => state,
    withinActiveHours
};
