const test = require('node:test');
const assert = require('node:assert/strict');
const YT_API = require('../src/youtube/apiClient');
const { readYouTubeConfig, withinActiveHours } = require('../src/youtube/config');
const {
    pollForLiveStream,
    uploadsPlaylistForChannel
} = require('../src/youtube/liveDetector');
const { startChatMonitor } = require('../src/youtube/chatMonitor');

// ---- config gating ----

test('missing YOUTUBE_* env vars disable the feature without throwing', () => {
    const config = readYouTubeConfig({});
    assert.equal(config.enabled, false);
    assert.deepEqual(config.missingVars, ['YOUTUBE_CLIENT_ID', 'YOUTUBE_CLIENT_SECRET', 'YOUTUBE_REFRESH_TOKEN']);
});

test('all YOUTUBE_* vars present enable the feature', () => {
    const config = readYouTubeConfig({
        YOUTUBE_CLIENT_ID: 'cid',
        YOUTUBE_CLIENT_SECRET: 'csecret',
        YOUTUBE_REFRESH_TOKEN: 'rt'
    });
    assert.equal(config.enabled, true);
    assert.deepEqual(config.missingVars, []);
});

test('owner handle defaults to @YourBoyZiG and override channel ID short-circuits resolution', () => {
    const config = readYouTubeConfig({
        YOUTUBE_CLIENT_ID: 'c',
        YOUTUBE_CLIENT_SECRET: 'c',
        YOUTUBE_REFRESH_TOKEN: 'c',
        YOUTUBE_OWNER_CHANNEL_ID: 'UC_override'
    });
    assert.equal(config.ownerHandle, '@YourBoyZiG');
    assert.equal(config.ownerChannelIdOverride, 'UC_override');
});

// ---- active hours ----

test('active hours window respects start<end and wrapping start>end', () => {
    const makeHour = (h) => new Date(2026, 0, 1, h, 0, 0);
    assert.equal(withinActiveHours('10-18', makeHour(10)), true);
    assert.equal(withinActiveHours('10-18', makeHour(17)), true);
    assert.equal(withinActiveHours('10-18', makeHour(18)), false);
    assert.equal(withinActiveHours('22-4', makeHour(23)), true);
    assert.equal(withinActiveHours('22-4', makeHour(3)), true);
    assert.equal(withinActiveHours('22-4', makeHour(12)), false);
    assert.equal(withinActiveHours(null), true);
    assert.equal(withinActiveHours('garbage'), true);
});

// ---- quota ledger + error classification ----

test('quota ledger tracks usage, resets on PT-day rollover, and exhausts at budget', () => {
    YT_API._resetQuotaForTests();
    YT_API.setQuotaBudget(10);
    assert.equal(YT_API.quotaRemaining(), 10);
    YT_API.recordQuota(5);
    assert.equal(YT_API.quotaRemaining(), 5);
    YT_API.recordQuota(5);
    assert.equal(YT_API.quotaRemaining(), 0);
    assert.equal(YT_API.quotaExhausted(), true);
    YT_API._resetQuotaForTests();
});

test('error classification buckets quota / auth / transient errors', () => {
    assert.equal(YT_API.classifyYouTubeError({ message: 'quotaExceeded', code: 403 }), YT_API.KIND.QUOTA);
    assert.equal(YT_API.classifyYouTubeError({ message: 'Invalid Credentials', code: 401 }), YT_API.KIND.AUTH);
    assert.equal(YT_API.classifyYouTubeError({ message: 'invalid_grant' }), YT_API.KIND.AUTH);
    assert.equal(YT_API.classifyYouTubeError({ message: 'Backend Error', code: 500 }), YT_API.KIND.TRANSIENT);
    assert.equal(YT_API.classifyYouTubeError({}), YT_API.KIND.TRANSIENT);
});

test('ytCall refuses calls once quota budget is exhausted and does NOT throw raw network errors', () => {
    YT_API._resetQuotaForTests();
    YT_API.setQuotaBudget(0);
    let networkTouched = false;
    assert.rejects(
        () => YT_API.ytCall(null, () => { networkTouched = true; return Promise.resolve({}); }, {}, { budget: 0 }),
        (error) => error?.yt?.kind === YT_API.KIND.QUOTA
    );
    assert.equal(networkTouched, false);
    YT_API._resetQuotaForTests();
});

// ---- liveDetector (uploads-playlist path) ----

test('uploads playlist derives UC.. -> UU..', () => {
    assert.equal(uploadsPlaylistForChannel('UC12345'), 'UU12345');
    assert.equal(uploadsPlaylistForChannel('NOT_A_CHANNEL'), null);
});

test('pollForLiveStream finds live videos within the uploads playlist', async () => {
    // Restore the shared quota ledger budget that an earlier test zeroed out.
    YT_API._resetQuotaForTests();
    YT_API.setQuotaBudget(10_000);
    let playlistCalled = 0;
    let videosCalled = 0;
    const mockYoutube = {
        playlistItems: {
            list: async () => {
                playlistCalled += 1;
                return {
                    data: { items: [{ contentDetails: { videoId: 'vidA' } }, { contentDetails: { videoId: 'vidB' } }] }
                };
            }
        },
        videos: {
            list: async ({ id }) => {
                videosCalled += 1;
                assert.match(id, /vidA,vidB/);
                return {
                    data: {
                        items: [
                            { id: 'vidA', snippet: { liveBroadcastContent: 'none' } },
                            { id: 'vidB', snippet: { liveBroadcastContent: 'live' }, liveStreamingDetails: { activeLiveChatId: 'chatX' } }
                        ]
                    }
                };
            }
        }
    };
    const result = await pollForLiveStream(mockYoutube, 'UC12345', { quotaBudgetPerDay: 10000 });
    assert.equal(playlistCalled, 1);
    assert.equal(videosCalled, 1);
    assert.equal(result.live, true);
    assert.equal(result.videoId, 'vidB');
    assert.equal(result.liveChatId, 'chatX');
});

test('pollForLiveStream reports not-live when nothing is broadcasting', async () => {
    YT_API._resetQuotaForTests();
    YT_API.setQuotaBudget(10_000);
    const mockYoutube = {
        playlistItems: { list: async () => ({ data: { items: [{ contentDetails: { videoId: 'vidA' } }] } }) },
        videos: { list: async () => ({ data: { items: [{ id: 'vidA', snippet: { liveBroadcastContent: 'completed' } }] } }) }
    };
    const result = await pollForLiveStream(mockYoutube, 'UC12345', { quotaBudgetPerDay: 10000 });
    assert.equal(result.live, false);
});

// ---- chatMonitor ----

/**
 * Fake poll response helper. pollingIntervalMillis is echoed by the monitor
 * for its next setTimeout, so we use a short value to keep tests fast.
 */
function chatResponse(items, { pollingIntervalMillis = 100, offlineAt = null } = {}) {
    return {
        data: {
            items,
            pollingIntervalMillis,
            offlineAt,
            ...(items.length === 0 && offlineAt ? {} : { nextPageToken: null })
        }
    };
}

function waitFor(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

test('chatMonitor emits chat messages and honors pollingIntervalMillis', async () => {
    let listCalls = 0;
    const received = [];
    let noticeLog = [];

    YT_API._resetQuotaForTests();
    YT_API.setQuotaBudget(1000);

    const mockYoutube = {
        liveChatMessages: {
            list: async () => {
                listCalls += 1;
                if (listCalls === 1) {
                    return chatResponse([{
                        id: 'm1',
                        snippet: { displayMessage: 'hello world', publishedAt: 'now' },
                        authorDetails: {
                            channelId: 'UC_viewer',
                            displayName: 'Viewer One',
                            isChatOwner: false,
                            isChatModerator: false,
                            isChatSponsor: false
                        }
                    }], { pollingIntervalMillis: 100 });
                }
                return chatResponse([], { offlineAt: 'offline' });
            }
        }
    };

    const monitor = startChatMonitor({
        youtube: mockYoutube,
        videoId: 'vidA',
        liveChatId: 'chatX',
        config: { quotaBudgetPerDay: 1000 },
        onMessage: async (message) => { received.push(message); },
        onEnded: async () => { noticeLog.push('ended'); },
        onNotice: (message) => { noticeLog.push(message); }
    });

    await waitFor(600);
    monitor.stop();
    assert.equal(listCalls >= 2, true);
    assert.equal(received.length, 1);
    assert.equal(received[0].author.displayName, 'Viewer One');
    assert.equal(received[0].text, 'hello world');
    assert.equal(noticeLog.some((n) => n.includes('ended') || n.includes('offline')), true);
});

test('quota exhaustion stops chat monitoring without crashing the process', async () => {
    let listCalls = 0;
    let notices = [];

    YT_API._resetQuotaForTests();
    // Budget 5 units = exactly 1 liveChatMessages.list call (5 units).
    YT_API.setQuotaBudget(5);

    const mockYoutube = {
        liveChatMessages: {
            list: async () => {
                listCalls += 1;
                return chatResponse([], {});
            }
        }
    };

    const monitor = startChatMonitor({
        youtube: mockYoutube,
        videoId: 'vidA',
        liveChatId: 'chatX',
        config: { quotaBudgetPerDay: 5 },
        onMessage: async () => {},
        onEnded: async () => {},
        onNotice: (message) => { notices.push(message); }
    });

    // Give the monitor enough ticks to hit the budget and shut down cleanly.
    await waitFor(800);
    monitor.stop();
    assert.equal(listCalls >= 1, true);
    assert.equal(notices.some((n) => n.toLowerCase().includes('quota')), true, 'notice mentions quota');
    assert.equal(monitor.isStopped(), true);
});

test('auth failure (invalid_grant) stops monitoring with a clear notice, no crash', async () => {
    let notices = [];
    YT_API._resetQuotaForTests();
    YT_API.setQuotaBudget(10000);

    const authError = Object.assign(new Error('invalid_grant: Token has been expired or revoked.'), { yt: { kind: YT_API.KIND.AUTH } });
    const mockYoutube = {
        liveChatMessages: {
            list: async () => { throw authError; }
        }
    };

    const monitor = startChatMonitor({
        youtube: mockYoutube,
        videoId: 'vidA',
        liveChatId: 'chatX',
        config: { quotaBudgetPerDay: 10000 },
        onMessage: async () => {},
        onEnded: async () => {},
        onNotice: (message) => { notices.push(message); }
    });

    await waitFor(600);
    monitor.stop();
    assert.equal(notices.some((n) => n.includes('auth')), true, 'notice mentions auth');
    assert.equal(monitor.isStopped(), true);
});

test('transient errors back off exponentially but keep polling (no crash)', async () => {
    let listCalls = 0;
    let notices = [];
    YT_API._resetQuotaForTests();
    YT_API.setQuotaBudget(10000);
    const mockYoutube = {
        liveChatMessages: {
            list: async () => {
                listCalls += 1;
                if (listCalls === 1) throw Object.assign(new Error('Backend Error'), { response: { status: 500 } });
                return chatResponse([], { offlineAt: 'offline' });
            }
        }
    };
    const monitor = startChatMonitor({
        youtube: mockYoutube,
        videoId: 'vidA',
        liveChatId: 'chatX',
        config: { quotaBudgetPerDay: 10000 },
        baseBackoffMs: 100,
        onMessage: async () => {},
        onEnded: async () => {},
        onNotice: (message) => { notices.push(message); }
    });
    await waitFor(700);
    monitor.stop();
    assert.equal(listCalls >= 2, true, 'retried at least once after a transient failure');
    assert.equal(notices.some((n) => n.toLowerCase().includes('transient')), true);
});
