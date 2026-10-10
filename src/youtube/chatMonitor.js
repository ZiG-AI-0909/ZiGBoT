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

const DEFAULT_FALLBACK_INTERVAL_MS = 5_000;
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
function startChatMonitor({ youtube, videoId, liveChatId, config, onMessage, onEnded, onNotice, baseBackoffMs = null, engagementIntervalMs = DEFAULT_ENGAGEMENT_INTERVAL_MS }) {
    const backoffBase = Math.max(50, Number(baseBackoffMs) || DEFAULT_FALLBACK_INTERVAL_MS);
    let stopped = false;
    let timer = null;
    let engagementTimer = null;
    let engagementMessageIndex = 0;
    let engagementDisabled = false;
    let pollIntervalMs = DEFAULT_FALLBACK_INTERVAL_MS;
    let pageToken = null;
    let consecutiveFailures = 0;
    const watcherStartedAt = Date.now();

    async function postEngagementMessage() {
        if (stopped || engagementDisabled) return;
        const messageText = ENGAGEMENT_MESSAGES[engagementMessageIndex % ENGAGEMENT_MESSAGES.length];
        engagementMessageIndex += 1;
        try {
            await YT_API.ytCall(
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
                { costUnits: 20, budget: config.quotaBudgetPerDay }
            );
        } catch (error) {
            if (onNotice) onNotice(`engagement message could not be posted: ${error.message}`);
            const kind = error?.yt?.kind || YT_API.classifyYouTubeError(error);
            if (kind === YT_API.KIND.QUOTA || kind === YT_API.KIND.AUTH) engagementDisabled = true;
        }
    }

    function scheduleEngagementMessage() {
        if (stopped || engagementDisabled) return;
        engagementTimer = setTimeout(async () => {
            await postEngagementMessage();
            scheduleEngagementMessage();
        }, Math.max(60_000, Number(engagementIntervalMs) || DEFAULT_ENGAGEMENT_INTERVAL_MS));
    }

    async function poll() {
        if (stopped) return;
        try {
            const response = await YT_API.ytCall(
                youtube,
                (params) => youtube.liveChatMessages.list(params),
                {
                    liveChatId,
                    part: 'id,snippet,authorDetails',
                    maxResults: 200,
                    ...(pageToken ? { pageToken } : {})
                },
                { costUnits: 5, budget: config.quotaBudgetPerDay }
            );

            consecutiveFailures = 0;

            // Honor the API's own pacing hint for the NEXT poll — this is the
            // official quota-friendly interval (5s early, longer later).
            pollIntervalMs = response?.data?.pollingIntervalMillis || DEFAULT_FALLBACK_INTERVAL_MS;
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
            const kind = error?.yt?.kind || YT_API.classifyYouTubeError(error);
            const detail = error?.message || String(error);

            if (kind === YT_API.KIND.QUOTA) {
                if (onNotice) onNotice(`quota exhausted, pausing YouTube chat for the rest of the PT day. ${detail}`);
                stop();
                return;
            }
            if (kind === YT_API.KIND.AUTH) {
                if (onNotice) onNotice(`auth failure (refresh token expired?), YouTube chat paused until restart. ${detail}`);
                stop();
                return;
            }
            if (kind === YT_API.KIND.PERMANENT || kind === YT_API.KIND.FORBIDDEN) {
                // 403 on a chat we were told to watch usually means the chat
                // ended mid-connection or we lost moderator access. Give up
                // quietly rather than spin.
                if (onNotice) onNotice(`live chat unreadable, stopping watcher for this video. ${detail}`);
                stop();
                return;
            }
            if (onNotice) onNotice(`transient chat error (attempt ${consecutiveFailures}), will retry. ${detail}`);

            // Exponential backoff on transient errors, capped at 60s.
            pollIntervalMs = Math.min(60_000, backoffBase * 2 ** consecutiveFailures);
        }

        if (!stopped) timer = setTimeout(poll, pollIntervalMs);
    }

    function stop() {
        stopped = true;
        if (timer) clearTimeout(timer);
        if (engagementTimer) clearTimeout(engagementTimer);
    }

    // A welcome prompt starts the conversation; later reminders are spaced
    // out so the bot encourages engagement without dominating the chat.
    if (config.engagementPrompts ?? DEFAULT_ENGAGEMENT_PROMPTS) {
        postEngagementMessage();
        scheduleEngagementMessage();
    }

    // Kick off the first poll immediately (async, never awaited by callers).
    setImmediate(() => { poll().catch((error) => {
        if (onNotice) onNotice(`chat monitor crashed unexpectedly: ${error.message}`);
        stop();
    }); });

    return {
        stop,
        isStopped: () => stopped,
        getPollingInterval: () => pollIntervalMs
    };
}

module.exports = { startChatMonitor, DEFAULT_FALLBACK_INTERVAL_MS, DEFAULT_ENGAGEMENT_INTERVAL_MS, DEFAULT_ENGAGEMENT_PROMPTS, FATAL_KINDS };
