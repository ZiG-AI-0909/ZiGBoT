const test = require('node:test');
const assert = require('node:assert/strict');
const { Greetings, isGreeting, mentionsBot, safeName, MAX_PENDING_REPLIES } = require('../src/youtube/greetings');
const YT_API = require('../src/youtube/apiClient');
const orch = require('../src/youtube');
const { buildDefinitions, runYouTubeInteraction } = require('../src/slash');

function makeHarness(options = {}) {
    let now = 100_000;
    const timers = [];
    const sent = [];
    const notices = [];
    const api = {
        KIND: YT_API.KIND,
        quotaRemaining: () => options.remaining ?? 10_000,
        classifyYouTubeError: YT_API.classifyYouTubeError,
        async ytCall(youtube, method, params) {
            if (options.sendError) throw options.sendError;
            return method(params);
        }
    };
    const youtube = { liveChatMessages: { insert: async (params) => { sent.push(params.requestBody.snippet.textMessageDetails.messageText); return {}; } } };
    const greetings = new Greetings({ youtube, videoId: 'v1', liveChatId: 'chat', botTitle: 'ZiGBoT Official',
        config: { greetingsEnabled: true, quotaReserve: options.reserve ?? 2500,
            maxRepliesPerStream: options.maxReplies ?? 60, quotaBudgetPerDay: 10_000,
            ignoredChannelIds: options.ignoredChannelIds || [], botName: 'ZiGBoT' },
        clock: () => now, random: options.random || (() => 0.1),
        setTimer: (fn, ms) => { const timer = { fn, ms }; timers.push(timer); return timer; },
        clearTimer: (timer) => { const index = timers.indexOf(timer); if (index >= 0) timers.splice(index, 1); },
        onNotice: (message) => notices.push(message), api
    });
    const msg = (id, channelId, text, extra = {}) => ({ id, text, publishedAt: new Date(now).toISOString(),
        watcherStartedAt: now, author: { channelId, displayName: `Viewer ${channelId}`, ...extra } });
    async function tick(ms = 0) {
        now += ms;
        const timer = timers.shift();
        if (timer) timer.fn();
        await new Promise((resolve) => setImmediate(resolve));
    }
    return { greetings, sent, notices, timers, msg, tick, youtube };
}

test('greeting matching accepts English, Hinglish, repeated letters, emoji, and rejects whole-word false positives', () => {
    for (const greeting of ['hi', 'Hiii!!! 👋', 'hello', 'helo', 'hlo', 'hey', 'heyy', 'yo', 'sup', 'namaste', 'namaskar', 'नमस्ते', 'hola', 'good morning', 'good afternoon', 'good evening', 'gm']) {
        assert.equal(isGreeting(greeting), true, greeting);
    }
    for (const nonGreeting of ['this', 'chill', 'history', 'which', 'hello everybody all around the world today', '!hi']) {
        assert.equal(isGreeting(nonGreeting), false, nonGreeting);
    }
});

test('greeting reply once per viewer, dedupes message ids, and ignores backlog/own/owner/moderators/bots/commands', async () => {
    const h = makeHarness({ ignoredChannelIds: ['UC_ignore'] });
    const old = h.msg('old', 'UC_old', 'hi'); old.publishedAt = new Date(old.watcherStartedAt - 4000).toISOString();
    assert.equal(await h.greetings.handle(old), false);
    for (const [id, name, flags] of [
        ['UC_self', 'Other', {}], ['UC_owner', 'Other', {}], ['UC_mod', 'Other', { isChatModerator: true }],
        ['UC_chatowner', 'Other', { isChatOwner: true }], ['UC_ignore', 'Other', {}], ['UC_nightbot', 'Nightbot', {}]
    ]) {
        const m = h.msg(`skip-${id}`, id, 'hey', { displayName: name, ...flags });
        if (id === 'UC_self') h.greetings.selfId = id;
        if (id === 'UC_owner') h.greetings.ownerId = id;
        assert.equal(await h.greetings.handle(m), false);
    }
    assert.equal(await h.greetings.handle(h.msg('cmd', 'UC_cmd', '!hi')), false);
    assert.equal(await h.greetings.handle(h.msg('evt', 'UC_evt', 'hi', { isChatOwner: false })), true);
    assert.equal(await h.greetings.handle(h.msg('evt', 'UC_evt', 'hi')), false);
    assert.equal(await h.greetings.handle(h.msg('second', 'UC_evt', 'hello')), false);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.sent.length, 1);
});

test('bot mentions use channel title or fallback name and enforce a separate 60 second cooldown', async () => {
    const h = makeHarness();
    assert.equal(mentionsBot('hello @ZiGBoT Official!', 'ZiGBoT Official', 'ZiGBoT'), true);
    assert.equal(mentionsBot('Hey ZiGBoT, are you there?', null, 'ZiGBoT'), true);
    assert.equal(await h.greetings.handle(h.msg('m1', 'UC_a', 'hello @ZiGBoT Official')), true);
    assert.equal(await h.greetings.handle(h.msg('m2', 'UC_a', 'ZiGBoT?')), false);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.sent.length, 1);
    await h.tick(60_001);
    assert.equal(await h.greetings.handle(h.msg('m3', 'UC_a', 'ZiGBoT?')), true);
});

test('global five second rate limit and queue overflow drop new replies', async () => {
    let release;
    const h = makeHarness();
    const original = h.greetings.api.ytCall;
    let first = true;
    h.greetings.api.ytCall = async (...args) => {
        if (first) { first = false; await new Promise((resolve) => { release = resolve; }); }
        return original(...args);
    };
    assert.equal(await h.greetings.handle(h.msg('one', 'UC0', 'hi')), true);
    for (let i = 1; i < MAX_PENDING_REPLIES; i += 1) {
        assert.equal(await h.greetings.handle(h.msg(`m${i}`, `UC${i}`, 'hello')), true);
    }
    assert.equal(await h.greetings.handle(h.msg('overflow', 'UCoverflow', 'hey')), false);
    release();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.sent.length, 1);
    assert.equal(h.timers[0].ms, 5000);
});

test('per-stream cap, quota reserve refusal, forbidden disable, and output sanitizing/length', async () => {
    const capped = makeHarness({ maxReplies: 1 });
    await capped.greetings.handle(capped.msg('1', 'UC1', 'hi'));
    await new Promise((resolve) => setImmediate(resolve));
    capped.greetings.lastSentAt = null;
    await capped.greetings.handle(capped.msg('2', 'UC2', 'hello'));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(capped.sent.length, 1);
    assert.equal(capped.notices.filter((note) => note.includes('cap reached')).length, 1);

    const quota = makeHarness({ remaining: 2500, reserve: 2500 });
    await quota.greetings.handle(quota.msg('1', 'UC1', 'hi'));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(quota.sent.length, 0);
    assert.equal(quota.notices.filter((note) => note.includes('reserve')).length, 1);

    const forbiddenError = Object.assign(new Error('forbidden'), { yt: { kind: YT_API.KIND.FORBIDDEN } });
    const forbidden = makeHarness({ sendError: forbiddenError });
    await forbidden.greetings.handle(forbidden.msg('1', 'UC1', 'hi'));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(forbidden.greetings.enabled, false);
    assert.match(forbidden.notices[0], /not be allowed to post/);

    assert.equal(safeName('A\n\u0001 Viewer'), 'A Viewer');
    const long = new Greetings({ youtube: {}, videoId: 'v', liveChatId: 'c', config: { greetingsEnabled: true }, random: () => 0 });
    assert.ok(long.makeReply('greeting', 'x'.repeat(1000)).length < 200);
});

test('owner-only /ytgreet gate and command registration', async () => {
    assert.ok(buildDefinitions().some((definition) => definition.name === 'ytgreet'));
    const settings = { serverOwnerId: 'owner' };
    const interaction = (userId) => ({ commandName: 'ytgreet', user: { id: userId }, options: { getString: () => 'off' } });
    assert.equal(await runYouTubeInteraction(interaction('not-owner'), settings), null);
    orch._seedStateForTests({ config: { quotaBudgetPerDay: 10_000, greetingsEnabled: true } });
    assert.match(await runYouTubeInteraction(interaction('owner'), settings), /greetings disabled/);
    assert.equal(orch.getYouTubeStatus().greetings, false);
    orch._resetForTestHarness();
});

test('moderation text uses the shared paced sender even when greeting replies are disabled', async () => {
    const sent = [];
    const api = {
        KIND: YT_API.KIND,
        quotaRemaining: () => 1000,
        classifyYouTubeError: YT_API.classifyYouTubeError,
        async ytCall(youtube, method, params) { return method(params); }
    };
    const sender = new Greetings({ youtube: { liveChatMessages: { insert: async (params) => sent.push(params.requestBody.snippet.textMessageDetails.messageText) } },
        videoId: 'v1', liveChatId: 'c1', config: { greetingsEnabled: false, quotaReserve: 2500, maxPendingReplies: 10 }, api });
    assert.equal(sender.enqueueText('timed out Viewer for 5 min', { quotaReserve: 400 }), true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(sent, ['timed out Viewer for 5 min']);
});

test('with greetings enabled and engagement prompts off, chat sends only the greeting reply', async () => {
    YT_API._resetQuotaForTests();
    YT_API.setQuotaBudget(10_000);
    orch._seedStateForTests({ youtube: null, ownerId: 'UCowner', selfId: 'UCself', config: {
        quotaBudgetPerDay: 10_000, autoDetect: false, greetingsEnabled: true, engagementPrompts: false,
        quotaReserve: 2500, maxRepliesPerStream: 60, ignoredChannelIds: [], botName: 'ZiGBoT'
    } });
    let calls = 0;
    const sent = [];
    let listCalls = 0;
    const youtube = { liveChatMessages: {
        list: async () => {
            listCalls += 1;
            return { data: { items: listCalls === 1 ? [{ id: 'greet1', snippet: {
                type: 'textMessageEvent', displayMessage: 'Hi', publishedAt: new Date().toISOString()
            }, authorDetails: { channelId: 'UCviewer', displayName: 'Viewer' } }] : [], pollingIntervalMillis: 20 } };
        },
        insert: async (params) => { calls += 1; sent.push(params.requestBody.snippet.textMessageDetails.messageText); return {}; }
    } };
    orch.stateGetter().youtube = youtube;
    const result = await orch.watch({ videoId: 'vidLIVE', liveChatId: 'chatLIVE' });
    assert.equal(result.ok, true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await orch.stopAll();
    assert.equal(calls, 1);
    assert.match(sent[0], /Viewer/);
    orch._resetForTestHarness();
    YT_API._resetQuotaForTests();
});
