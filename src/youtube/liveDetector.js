/**
 * Live-stream detection for the bot-channel token (per the user's explicit
 * choice): resolve the owner channel's uploads playlist (UC -> UU prefix),
 * poll playlistItems.list for the newest uploads, then videos.list with
 * liveStreamingDetails to see which one is currently live.
 *
 * Cost: playlistItems.list (1 unit) + videos.list (1 unit) per poll.
 * At the default 3-minute interval that is 2 units / poll = 40 units/hour of
 * watching and ~480 units/day of steady polling — left running 24/7 within
 * the shared 10,000 quota that is comfortably safe.
 *
 * IMPORTANT (per the user's instruction): if live streams do NOT appear in
 * the uploads playlist while live, detection is disabled loudly and the
 * next-cheapest alternative is PROPOSED, not silently implemented.
 */
const YT_API = require('./apiClient');
const { withinActiveHours } = require('./config');

const DEFAULT_INTERVAL_MS = 180_000;
const VIDEOS_TO_CHECK = 5;
const CONSECUTIVE_MISS_LIMIT = 4;

function uploadsPlaylistForChannel(channelId) {
    if (!channelId || !channelId.startsWith('UC')) return null;
    return `UU${channelId.slice(2)}`;
}

/**
 * One detection poll. Returns:
 *   { live: true, videoId, liveChatId, scheduledStreams } |
 *   { live: false, scheduledStreams } |
 *   { failed: true, kind }
 */
async function pollForLiveStream(youtube, channelId, config) {
    const playlistId = uploadsPlaylistForChannel(channelId);
    if (!playlistId) return { failed: true, kind: YT_API.KIND.PERMANENT, reason: 'bad channel id' };

    try {
        // 1 unit: newest uploads.
        const playlistRes = await YT_API.ytCall(
            youtube,
            (params) => youtube.playlistItems.list(params),
            { part: 'contentDetails', playlistId, maxResults: VIDEOS_TO_CHECK },
            { costUnits: 1, budget: config.quotaBudgetPerDay }
        );
        const videoIds = (playlistRes?.data?.items || [])
            .map((item) => item?.contentDetails?.videoId)
            .filter(Boolean);
        if (videoIds.length === 0) return { live: false };

        // 1 unit: which of these is live right now?
        const videosRes = await YT_API.ytCall(
            youtube,
            (params) => youtube.videos.list(params),
            { part: 'snippet,liveStreamingDetails', id: videoIds.join(',') },
            { costUnits: 1, budget: config.quotaBudgetPerDay }
        );

        const videos = videosRes?.data?.items || [];
        const liveVideo = videos.find((video) =>
            video?.snippet?.liveBroadcastContent === 'live'
        );
        const scheduledStreams = videos
            .filter((video) => video?.snippet?.liveBroadcastContent === 'upcoming'
                && video?.liveStreamingDetails?.scheduledStartTime)
            .map((video) => ({
                videoId: video.id,
                title: video.snippet?.title || '',
                scheduledStartTime: video.liveStreamingDetails.scheduledStartTime
            }));

        if (liveVideo) {
            return {
                live: true,
                videoId: liveVideo.id,
                liveChatId: liveVideo.liveStreamingDetails?.activeLiveChatId || null,
                title: liveVideo.snippet?.title || '',
                scheduledStreams
            };
        }
        return { live: false, scheduledStreams };
    } catch (error) {
        return { failed: true, kind: error?.yt?.kind || YT_API.KIND.TRANSIENT, reason: error.message };
    }
}

/**
 * Starts the polling loop. Calls `onLive`({ videoId, liveChatId }) when a new
 * live stream is detected and `onEnded`() when a previously watched stream
 * disappears. intervalMs and activeHours come from the YouTube config.
 * The loop self-schedules with setTimeout so it never stacks on slow calls.
 */
function startLiveDetector({ youtube, ownerId, config, onLive, onScheduled, onEnded, log }) {
    let consecutiveMisses = 0;
    let disabled = false;
    let timer = null;
    let running = false;
    let lastSeenLive = null; // videoId currently believed live
    const reportedScheduled = new Set();

    async function tick() {
        if (disabled || running) return;
        running = true;
        try {
            if (!withinActiveHours(config.activeHours)) {
                if (log) log('outside active hours, skipping detection poll');
                consecutiveMisses = 0;
                return;
            }

            const result = await pollForLiveStream(youtube, ownerId, config);
            if (result.failed) {
                consecutiveMisses += 1;
                if (log) log(`detection poll failed (${result.kind}): ${result.reason}`);
                if (result.kind === YT_API.KIND.AUTH) {
                    disabled = true;
                    if (log) log('auth failure - auto-detection disabled until restart.');
                } else if (consecutiveMisses >= CONSECUTIVE_MISS_LIMIT) {
                    disabled = true;
                    // The user asked: report this loudly, propose the fallback.
                    if (log) log(
                        'auto-detection disabled after repeated failures. Live streams may not be reachable via the uploads playlist. '
                        + 'PROPOSED next step: try liveBroadcasts.list only if the refresh token is later re-issued from the OWNER account (1 unit/call), '
                        + 'or fall back to the manual /watch <videoId> Discord command.'
                    );
                }
                return;
            }

            for (const stream of result.scheduledStreams || []) {
                if (reportedScheduled.has(stream.videoId)) continue;
                reportedScheduled.add(stream.videoId);
                if (reportedScheduled.size > 100) reportedScheduled.delete(reportedScheduled.values().next().value);
                if (onScheduled) await onScheduled(stream);
            }

            if (result.live) {
                consecutiveMisses = 0;
                if (lastSeenLive === result.videoId) return; // same stream, already reported
                lastSeenLive = result.videoId;
                if (log) log(`live stream detected: ${result.videoId} (${result.title})`);
                await onLive({ videoId: result.videoId, liveChatId: result.liveChatId, title: result.title });
            } else if (lastSeenLive) {
                if (log) log('live stream ended (detector).');
                lastSeenLive = null;
                await onEnded();
            }
        } catch (error) {
            // Never let a detector bug kill the process or the loop.
            if (log) log(`detector tick error: ${error.message}`);
        } finally {
            running = false;
        }
    }

    function schedule() {
        timer = setTimeout(async () => {
            await tick();
            if (!disabled) schedule();
        }, config.autoDetectIntervalMs || DEFAULT_INTERVAL_MS);
    }

    schedule();

    return {
        tick,
        stop() {
            disabled = true;
            if (timer) clearTimeout(timer);
        },
        isDisabled() { return disabled; }
    };
}

module.exports = { startLiveDetector, pollForLiveStream, uploadsPlaylistForChannel, DEFAULT_INTERVAL_MS, CONSECUTIVE_MISS_LIMIT };
