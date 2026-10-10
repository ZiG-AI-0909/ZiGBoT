/**
 * Live-chat monitor: reads liveChatMessages.list honoring the
 * pollingIntervalMillis the API returns (that value is the official pacing
 * hint — 5s while busy, growing as chat slows — and it IS the quota-friendly
 * choice), backoff on errors, and hand-off of every message to the caller.
 *
 * Cost is reported so the report can estimate units/hour of streaming:
 *   liveChatMessages.list = 5 units per poll. pollIntervalMs starts around
 *   5000 -> ~3,600 units/hour of hot chat, degrading as YouTube slows the
 *   poll to 10s+ on quieter streams.
 *
 * Failure contract: any error is classified, reported via `onNotice`, and
 * the poll loop backs off. Nothing here throws into the Discord bot's
 * execution path.
 */
const YT_API = require('./apiClient');

const DEFAULT_FALLBACK_INTERVAL_MS = 8_000;
const DEFAULT_MIN_POLL_MS = 8_000;
const DEFAULT_IDLE_BACKOFF_AFTER_MS = 3 * 60_000;
const DEFAULT_IDLE_BACKOFF_MAX_MS = 60_000;
const QUOTA_SUMMARY_INTERVAL_MS = 10 * 60_000;
const DEFAULT_ENGAGEMENT_INTERVAL_MS = 15 * 60_000;
const DEFAULT_ENGAGEMENT_PROMPTS = false;
const ENGAGEMENT_MESSAGES = [
    'Enjoying the stream? Please hit like and subscribe, and tell us in chat what you think! 💙',
    'Thanks for hanging out! If you’re enjoying it, leave a like, subscribe, and keep the chat going 😊',
    'What has been your favorite moment so far? Drop it in chat—and remember to like and subscribe if you’re having fun!'
];
const FATAL_KINDS = new Set([YT_API.KIND.QUOTA, YT_API.KIND.AUTH]);

/**
 * Stream chat for one video. Message shape passed to onMessage:
 *   { id, text, author: { channelId, displayName, isChatOwner,
 *     isChatModerator, isChatSponsor }, publishedAt }
 */
function startChatMonitor({ youtube, videoId, liveChatId, config, onMessage, onEnded, onNotice, onQuotaExhausted,
    baseBackoffMs = null, engagementIntervalMs = DEFAULT_ENGAGEMENT_INTERVAL_MS,
    clock = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout,
    setIntervalFn = setInterval, clearIntervalFn = clearInterval, summaryIntervalMs = QUOTA_SUMMARY_INTERVAL_MS,
    api = YT_API } = {}) {
    const backoffBase = Math.max(50, Number(baseBackoffMs) || DEFAULT_FALLBACK_INTERVAL_MS);
    const minPollMs = Math.max(1, Number(config.minPollMs) || DEFAULT_MIN_POLL_MS);
    let stopped = false;
    let timer = null;
    let engagementTimer = null;
    let summaryTimer = null;
    let engagementMessageIndex = 0;
    let engagementDisabled = false;
    let pollIntervalMs = minPollMs;
    let apiHintMs = minPollMs;
    let idleSince = null;
    let summaryStart = api.quotaMethodUsage?.() || {};
    let pageToken = null;
    let consecutiveFailures = 0;
    const watcherStartedAt = Date.now();

    async function postEngagementMessage() {
        if (stopped || engagementDisabled) return;
        const messageText = ENGAGEMENT_MESSAGES[engagementMessageIndex % ENGAGEMENT_MESSAGES.length];
        engagementMessageIndex += 1;
        try {
            await api.ytCall(
                youtube,
                (params) => youtube.liveChatMessages.insert(params),
                {
                    part: 'snippet',
                    requestBody: {
                        snippet: {
                            liveChatId,
                            type: 'textMessageEvent',
                            textMessageDetails: { messageText }
                        }
                    }
                },
                { costUnits: 20, budget: config.quotaBudgetPerDay, method: 'liveChatMessages.insert' }
            );
        } catch (error) {
            if (onNotice) onNotice(`engagement message could not be posted: ${error.message}`);
            const kind = error?.yt?.kind || api.classifyYouTubeError(error);
            if (kind === api.KIND.QUOTA || kind === api.KIND.AUTH) engagementDisabled = true;
        }
    }

    function scheduleEngagementMessage() {
        if (stopped || engagementDisabled) return;
        engagementTimer = setTimer(async () => {
            await postEngagementMessage();
            scheduleEngagementMessage();
        }, Math.max(60_000, Number(engagementIntervalMs) || DEFAULT_ENGAGEMENT_INTERVAL_MS));
    }

    async function poll() {
        if (stopped) return;
        try {
            const response = await api.ytCall(
                youtube,
                (params) => youtube.liveChatMessages.list(params),
                {
                    liveChatId,
                    part: 'id,snippet,authorDetails',
                    maxResults: 200,
                    ...(pageToken ? { pageToken } : {})
                },
                { costUnits: 5, budget: config.quotaBudgetPerDay, method: 'liveChatMessages.list' }
            );

            consecutiveFailures = 0;

            // The configured floor only lengthens the API's suggested cadence.
            // Once chat has been idle for several minutes, increase further.
            apiHintMs = Math.max(1, Number(response?.data?.pollingIntervalMillis) || DEFAULT_FALLBACK_INTERVAL_MS);
            const itemCount = response?.data?.items?.length || 0;
            if (itemCount > 0) idleSince = null;
            else if (idleSince === null) idleSince = clock();
            const idleSteps = idleSince === null ? 0 : Math.floor((clock() - idleSince) / DEFAULT_IDLE_BACKOFF_AFTER_MS);
            const idleInterval = Math.min(DEFAULT_IDLE_BACKOFF_MAX_MS, minPollMs * (1 + Math.max(0, idleSteps)));
            pollIntervalMs = Math.max(apiHintMs, minPollMs, idleInterval);
            pageToken = response?.data?.nextPageToken || null;

            for (const item of response?.data?.items || []) {
                await onMessage({
                    id: item.id,
                    eventType: item.snippet?.type,
                    rawText: item.snippet?.textMessageDetails?.messageText ?? null,
                    text: item.snippet?.displayMessage || item.snippet?.textMessageDetails?.messageContent || '',
                    author: {
                        channelId: item.authorDetails?.channelId,
                        displayName: item.authorDetails?.displayName,
                        isChatOwner: Boolean(item.authorDetails?.isChatOwner),
                        isChatModerator: Boolean(item.authorDetails?.isChatModerator),
                        isChatSponsor: Boolean(item.authorDetails?.isChatSponsor)
                    },
                    publishedAt: item.snippet?.publishedAt,
                    watcherStartedAt
                });
            }

            if (response?.data?.items?.length === 0 && response?.data?.offlineAt) {
                // Chat offline = stream ended.
                if (onEnded) await onEnded();
                if (onNotice) onNotice('live chat offline, stream appears ended.');
                stop();
                return;
            }
        } catch (error) {
            consecutiveFailures += 1;
            const kind = error?.yt?.kind || api.classifyYouTubeError(error);
            const detail = error?.message || String(error);

            if (kind === api.KIND.QUOTA) {
                if (onNotice) onNotice(`quota exhausted, pausing YouTube chat until the next Pacific quota reset. ${detail}`);
                // Tell the orchestrator so it can schedule a post-reset retry
                // instead of leaving YouTube dead for the process lifetime.
                if (onQuotaExhausted) {
                    try { await onQuotaExhausted(error); }
                    catch (retryError) { if (onNotice) onNotice(`quota reset retry could not be scheduled: ${retryError.message}`); }
                }
                stop();
                return;
            }
            if (kind === api.KIND.AUTH) {
                if (onNotice) onNotice(`auth failure (refresh token expired?), YouTube chat paused until restart. ${detail}`);
                stop();
                return;
            }
            if (kind === api.KIND.PERMANENT || kind === api.KIND.FORBIDDEN) {
                // 403 on a chat we were told to watch usually means the chat
                // ended mid-connection or we lost moderator access. Give up
                // quietly rather than spin.
                if (onNotice) onNotice(`live chat unreadable, stopping watcher for this video. ${detail}`);
                stop();
                return;
            }
            if (onNotice) onNotice(`transient chat error (attempt ${consecutiveFailures}), will retry. ${detail}`);

            // Exponential backoff on transient errors, capped at 60s.
            pollIntervalMs = Math.max(apiHintMs, minPollMs, Math.min(60_000, backoffBase * 2 ** consecutiveFailures));
        }

        if (!stopped) timer = setTimer(poll, pollIntervalMs);
    }

    function logQuotaSummary() {
        const current = api.quotaMethodUsage?.() || {};
        const methods = new Set([...Object.keys(summaryStart), ...Object.keys(current)]);
        const entries = [...methods].map((method) => {
            const before = summaryStart[method] || {};
            const after = current[method] || {};
            const calls = (after.calls || 0) - (before.calls || 0);
            const units = (after.units || 0) - (before.units || 0);
            return calls || units ? `${method}: ${calls} calls, ${units} units` : null;
        }).filter(Boolean);
        if (entries.length && onNotice) onNotice(`YouTube quota summary (last 10m): ${entries.join('; ')}`);
        summaryStart = current;
    }

    function stop() {
        stopped = true;
        if (timer) clearTimer(timer);
        if (engagementTimer) clearTimer(engagementTimer);
        if (summaryTimer) clearIntervalFn(summaryTimer);
    }

    // A welcome prompt starts the conversation; later reminders are spaced
    // out so the bot encourages engagement without dominating the chat.
    if (config.engagementPrompts ?? DEFAULT_ENGAGEMENT_PROMPTS) {
        postEngagementMessage();
        scheduleEngagementMessage();
    }
    summaryTimer = setIntervalFn(logQuotaSummary, Math.max(1_000, Number(summaryIntervalMs) || QUOTA_SUMMARY_INTERVAL_MS));

    // Kick off the first poll immediately (async, never awaited by callers).
    setImmediate(() => { poll().catch((error) => {
        if (onNotice) onNotice(`chat monitor crashed unexpectedly: ${error.message}`);
        stop();
    }); });

    return {
        stop,
        isStopped: () => stopped,
        getPollingInterval: () => pollIntervalMs,
        getApiHintInterval: () => apiHintMs,
        logQuotaSummary
    };
}

module.exports = { startChatMonitor, DEFAULT_FALLBACK_INTERVAL_MS, DEFAULT_MIN_POLL_MS,
    DEFAULT_IDLE_BACKOFF_AFTER_MS, DEFAULT_IDLE_BACKOFF_MAX_MS, QUOTA_SUMMARY_INTERVAL_MS,
    DEFAULT_ENGAGEMENT_INTERVAL_MS, DEFAULT_ENGAGEMENT_PROMPTS, FATAL_KINDS };
