const test = require('node:test');
const assert = require('node:assert/strict');

const YT_API = require('../src/youtube/apiClient');
const orch = require('../src/youtube/index');

// Reset the shared quota ledger and orchestrator state between tests.
function resetAll() {
    YT_API._resetQuotaForTests();
    YT_API.setQuotaBudget(10_000);
    orch._resetForTestHarness();
}

function makeMockYoutube() {
    let videosListCalls = 0;
    let chatListCalls = 0;
    return {
        videosListCalls: () => videosListCalls,
        chatListCalls: () => chatListCalls,
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
            list: async () => {
                chatListCalls += 1;
                return {
                    data: { items: [], pollingIntervalMillis: 50 }
                };
            }
        }
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

test('unwatch from a non-owner is silently ignored', async () => {
    resetAll();
    seedWithMock();
    const reply = await orch.handleUnwatchCommand(false);
    assert.equal(reply, null);
    resetAll();
});
