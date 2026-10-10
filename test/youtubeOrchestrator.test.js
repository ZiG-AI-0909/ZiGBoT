const test = require('node:test');
const assert = require('node:assert/strict');

const YT_API = require('../src/youtube/apiClient');
const orch = require('../src/youtube/index');
const { _resetForTests: resetOwnerChannel } = require('../src/youtube/ownerChannel');
const { buildDefinitions, runYouTubeInteraction } = require('../src/slash');

// Reset the shared quota ledger and orchestrator state between tests.
function resetAll() {
    YT_API._resetQuotaForTests();
    YT_API.setQuotaBudget(10_000);
    orch._resetForTestHarness();
}

function makeMockYoutube() {
    let videosListCalls = 0;
    let chatListCalls = 0;
    const chatLiveIds = [];
    return {
        videosListCalls: () => videosListCalls,
        chatListCalls: () => chatListCalls,
        chatLiveIds: () => [...chatLiveIds],
        videos: {
            list: async ({ id, part }) => {
                videosListCalls += 1;
                if (String(part).includes('liveStreamingDetails') && String(id).includes('vidLIVE')) {
                    return {
                        data: {
                            items: [{ id: 'vidLIVE', liveStreamingDetails: { activeLiveChatId: 'chatLIVE' } }]
                        }
                    };
                }
                return { data: { items: [] } };
            }
        },
        liveChatMessages: {
            list: async ({ liveChatId }) => {
                chatListCalls += 1;
                chatLiveIds.push(liveChatId);
                return {
                    data: { items: [], pollingIntervalMillis: 50 }
                };
            }
        }
    };
}

/**
 * Init harness: a fake wall clock, fake timers, and a fake Mongo quota ledger
 * so the post-reset retry can be inspected without waiting until midnight PT.
 */
function makeInitHarness({ ledgerBy = {}, budget = 10_000 } = {}) {
    const timers = [];
    const notices = [];
    let current = new Date('2026-10-10T20:00:00Z'); // 13:00 PDT
    YT_API._resetQuotaForTests();
    YT_API.setQuotaBudget(budget);
    YT_API._setQuotaClock(() => current);
    const deps = {
        youtube: makeMockYoutube(),
        discordClient: null,
        settings: { logChannelId: '' },
        ai: null,
        brain: {
            getYtQuotaLedger: async (pacificDate) => ledgerBy[pacificDate] || null,
            recordYtQuotaCall: async () => {},
            markYtQuotaExhausted: async () => {}
        },
        now: () => current,
        random: () => 0,
        setTimer: (fn, ms) => { const timer = { fn, ms, cleared: false, unref() {} }; timers.push(timer); return timer; },
        clearTimer: (timer) => { if (timer) timer.cleared = true; }
    };
    return { deps, timers, notices, setNow: (date) => { current = date; } };
}

function initConfig(overrides = {}) {
    return {
        enabled: true,
        missingVars: [],
        ownerChannelIdOverride: 'UC_owner_cfg',
        ownerHandle: '@owner',
        botChannelId: 'UC_bot_cfg',
        autoDetect: false,
        autoDetectIntervalMs: 180_000,
        activeHours: null,
        quotaBudgetPerDay: 10_000,
        ...overrides
    };
}

function seedWithMock({ selfId = null } = {}) {
    const mock = makeMockYoutube();
    orch._seedStateForTests({
        youtube: mock,
        ownerId: 'UC_owner',
        selfId,
        config: {
            quotaBudgetPerDay: 10_000,
            autoDetect: false,
            activeHours: null,
            autoDetectIntervalMs: 180_000
        }
    });
    return mock;
}

test('handleWatchCommand refuses when a non-owner calls it, silently', async () => {
    resetAll();
    seedWithMock();
    const reply = await orch.handleWatchCommand('vidLIVE', false);
    assert.equal(reply, null); // silent ignore for non-owners
    resetAll();
});

test('handleWatchCommand refuses cleanly when YouTube is disabled', async () => {
    resetAll();
    const result = await orch.watch({ videoId: 'vidLIVE' });
    assert.equal(result.ok, false);
    assert.match(result.error, /disabled/i);
});

test('watch resolves activeLiveChatId and starts the monitor (happy path)', async () => {
    resetAll();
    const mock = seedWithMock({ selfId: 'UC_self' });
    const result = await orch.watch({ videoId: 'vidLIVE', via: 'manual' });
    assert.equal(result.ok, true);
    assert.equal(orch.getYouTubeStatus().watching, 'vidLIVE');
    assert.equal(mock.videosListCalls(), 1); // exactly one videos.list to resolve the chat id

    // Give the monitor's setImmediate a beat to issue its first chat poll.
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(mock.chatListCalls() >= 1, true, 'chat messages polled');
    await orch.handleUnwatchCommand(true);
    resetAll();
});

test('watch refuses a video with no active live chat', async () => {
    resetAll();
    seedWithMock();
    const result = await orch.watch({ videoId: 'vidOFFLINE', via: 'manual' });
    assert.equal(result.ok, false);
    assert.match(result.error, /no active live chat/i);
});

test('watching the same video twice is idempotent, and unwatch stops it', async () => {
    resetAll();
    seedWithMock();
    const first = await orch.watch({ videoId: 'vidLIVE', via: 'manual' });
    assert.equal(first.ok, true);
    const second = await orch.watch({ videoId: 'vidLIVE', via: 'manual' });
    assert.equal(second.ok, true);
    assert.equal(second.already, true);

    const stopped = await orch.handleUnwatchCommand(true);
    assert.match(stopped, /Stopped watching/);
    assert.equal(orch.getYouTubeStatus().watching, null);

    const nothing = await orch.handleUnwatchCommand(true);
    assert.match(nothing, /Nothing was being watched/);
    resetAll();
});

test('concurrent auto/manual watch requests sharing a live chat install one watcher, and switching stops the old loop', async () => {
    resetAll();
    const mock = seedWithMock();
    const [first, second] = await Promise.all([
        orch.watch({ videoId: 'vidAUTO', liveChatId: 'chatSHARED', via: 'auto-detect' }),
        orch.watch({ videoId: 'vidMANUAL', liveChatId: 'chatSHARED', via: 'manual' })
    ]);
    assert.equal(first.ok, true);
    assert.equal(second.already, true);
    assert.equal(orch.stateGetter().watcherLiveChatId, 'chatSHARED');
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.deepEqual(mock.chatLiveIds(), ['chatSHARED']);

    const switched = await orch.watch({ videoId: 'vidNEXT', liveChatId: 'chatNEXT', via: 'manual' });
    assert.equal(switched.ok, true);
    assert.equal(orch.stateGetter().watcherLiveChatId, 'chatNEXT');
    await orch.handleUnwatchCommand(true);
    assert.equal(orch.stateGetter().watcher, null);
    resetAll();
});

test('unwatch from a non-owner is silently ignored', async () => {
    resetAll();
    seedWithMock();
    const reply = await orch.handleUnwatchCommand(false);
    assert.equal(reply, null);
    resetAll();
});

test('an exhausted ledger at startup pauses YouTube instead of disabling it, and schedules a retry at the Pacific reset', async () => {
    const h = makeInitHarness({ ledgerBy: {
        '2026-10-10': { usedUnits: 10_000, exhausted: true, methods: { liveChatMessages_list: { calls: 2000, units: 10_000 } } }
    } });
    const result = await orch.initYouTube(initConfig(), h.deps);
    assert.equal(result.enabled, false);
    assert.equal(result.quotaWaiting, true, 'quota failure is a wait, not a permanent disable');
    assert.ok(result.quotaRetryAt instanceof Date);
    assert.equal(result.quotaRetryAt.toISOString(), '2026-10-11T07:02:00.000Z');
    assert.equal(h.timers.length, 1, 'exactly one retry timer is pending');
    assert.equal(h.timers[0].cleared, false);
    assert.ok(h.timers[0].ms > 0);

    const status = orch.getYouTubeStatus();
    assert.equal(status.quotaWaiting, true);
    assert.equal(status.enabled, false);
    assert.equal(status.quotaRetryAt, '2026-10-11T07:02:00.000Z');
    assert.equal(status.autoDetect, false);
    assert.equal(status.quotaUsed, 10_000);
    assert.equal(status.quotaBudget, 10_000);

    // /ytstatus renders the wait state and the retry time for the owner.
    const ytstatus = await runYouTubeInteraction(
        { commandName: 'ytstatus', user: { id: 'owner' }, options: { getString: () => null } },
        { serverOwnerId: 'owner' });
    assert.match(ytstatus, /quota state: waiting for quota reset \(retry 2026-10-11T07:02:00\.000Z\)/);

    orch._resetForTestHarness();
    YT_API._resetQuotaForTests();
});

test('the retry after the Pacific reset hydrates the new PT day at zero and resumes auto-detect', async () => {
    const h = makeInitHarness({ ledgerBy: { '2026-10-10': { usedUnits: 10_000, exhausted: true } } });
    try {
        const waiting = await orch.initYouTube(initConfig({ autoDetect: true }), h.deps);
        assert.equal(waiting.quotaWaiting, true);
        const retryTimer = h.timers.at(-1);

        // The next PT day: no persisted row for the new date, so the ledger is 0.
        h.setNow(new Date('2026-10-11T07:02:00.000Z'));
        await retryTimer.fn();

        const status = orch.getYouTubeStatus();
        assert.equal(status.quotaWaiting, false);
        assert.equal(status.enabled, true);
        assert.equal(status.lastInitError, null);
        assert.equal(status.quotaUsed, 0);
        assert.equal(status.autoDetect, true, 'auto-detect resumes after the reset');
    } finally {
        orch._resetForTestHarness();
        YT_API._resetQuotaForTests();
    }
});

test('a non-quota init failure still disables YouTube and never schedules a retry', async () => {
    const h = makeInitHarness({});
    const authError = Object.assign(new Error('invalid_grant: Token has been expired or revoked.'), { yt: { kind: YT_API.KIND.AUTH } });
    h.deps.youtube = { channels: { list: async () => { throw authError; } } };
    resetOwnerChannel();
    const result = await orch.initYouTube(initConfig({ ownerChannelIdOverride: null, botChannelId: null }), h.deps);
    assert.equal(result.enabled, false);
    assert.equal(result.quotaWaiting, false, 'auth failures stay permanently disabled');
    assert.equal(result.quotaRetryAt, null);
    assert.equal(result.lastInitError.kind, 'auth');
    assert.equal(h.timers.length, 0, 'no retry timer for a permanent failure');
    const status = orch.getYouTubeStatus();
    assert.equal(status.quotaWaiting, false);
    assert.equal(status.quotaRetryAt, null);
    orch._resetForTestHarness();
    YT_API._resetQuotaForTests();
});

test('quota exhaustion mid-stream stops the watcher and schedules the post-reset retry', async () => {
    const h = makeInitHarness({});
    try {
        const started = await orch.initYouTube(initConfig(), h.deps);
        assert.equal(started.enabled, true);
        // Google starts answering quotaExceeded for the chat poll.
        h.deps.youtube.liveChatMessages.list = async () => {
            throw { code: 403, response: { data: { error: { errors: [{ reason: 'quotaExceeded' }] } } } };
        };
        const result = await orch.watch({ videoId: 'vidLIVE', liveChatId: 'chatLIVE', via: 'manual' });
        assert.equal(result.ok, true);
        await new Promise((resolve) => setTimeout(resolve, 60));

        const status = orch.getYouTubeStatus();
        assert.equal(status.quotaWaiting, true);
        assert.equal(status.enabled, false);
        assert.equal(status.watching, null, 'the poll loop is stopped, not left spinning');
        assert.ok(status.quotaRetryAt, 'a retry is scheduled for after the reset');
        assert.equal(h.timers.filter((timer) => !timer.cleared).length, 1);
    } finally {
        orch._resetForTestHarness();
        YT_API._resetQuotaForTests();
    }
});

test('/ytretry is registered and owner-only', async () => {
    assert.ok(buildDefinitions().some((definition) => definition.name === 'ytretry'));
    const settings = { serverOwnerId: 'owner' };
    const interaction = (userId) => ({ commandName: 'ytretry', user: { id: userId } });
    assert.equal(await runYouTubeInteraction(interaction('not-owner'), settings), null);

    // No credentials in the test process: the owner path re-runs init and
    // reports the failure rather than throwing into the Discord handler.
    const saved = ['YOUTUBE_CLIENT_ID', 'YOUTUBE_CLIENT_SECRET', 'YOUTUBE_REFRESH_TOKEN']
        .map((name) => [name, process.env[name]]);
    for (const [name] of saved) delete process.env[name];
    try {
        const reply = await runYouTubeInteraction(interaction('owner'), settings);
        assert.match(reply, /re-initialization failed/);
    } finally {
        for (const [name, value] of saved) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
        orch._resetForTestHarness();
    }
});

test('getYouTubeStatus exposes per-method quota usage for /ytstatus', async () => {
    resetAll();
    seedWithMock();
    await orch.watch({ videoId: 'vidLIVE', via: 'manual' });
    // Give the monitor's setImmediate a beat to issue its first chat poll.
    await new Promise((resolve) => setTimeout(resolve, 60));
    const methods = orch.getYouTubeStatus().quotaMethods;
    assert.equal(orch.getYouTubeStatus().quotaWaiting, false);
    assert.equal(methods.videos_list.calls >= 1, true, 'videos.list call counted');
    assert.equal(methods.videos_list.units >= 1, true, 'videos.list units counted');
    assert.equal(methods.liveChatMessages_list.calls >= 1, true, 'liveChatMessages.list call counted');
    assert.equal(methods.liveChatMessages_list.units >= 5, true, 'liveChatMessages.list units counted');
    await orch.handleUnwatchCommand(true);
    resetAll();
});
