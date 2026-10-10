const test = require('node:test');
const assert = require('node:assert/strict');
const YT_API = require('../src/youtube/apiClient');
const { YouTubeCommandRouter } = require('../src/youtube/commands');
const { ChatterCache, normalizeDisplayName, DEFAULT_RETENTION_MS } = require('../src/youtube/chatterCache');
const { buildDefinitions, runYouTubeInteraction } = require('../src/slash');
const orch = require('../src/youtube');

function harness(options = {}) {
    let now = 100_000;
    let remaining = options.remaining ?? 10_000;
    const timers = [];
    const calls = { bans: [], unbans: [], deletes: [] };
    const replies = [];
    const audits = [];
    const notices = [];
    let banSequence = 0;
    const youtube = {
        liveChatBans: {
            insert: async (params) => { calls.bans.push(params); return { data: { id: `ban-${++banSequence}` } }; },
            delete: async (params) => { calls.unbans.push(params); return { data: {} }; }
        },
        liveChatMessages: { delete: async (params) => { calls.deletes.push(params); return { data: {} }; } }
    };
    const api = {
        KIND: YT_API.KIND,
        quotaRemaining: () => remaining,
        classifyYouTubeError: YT_API.classifyYouTubeError,
        async ytCall(_client, method, params, { costUnits }) {
            if (options.error) {
                const error = options.error;
                error.yt ||= { kind: YT_API.classifyYouTubeError(error) };
                throw error;
            }
            if (remaining < costUnits) throw Object.assign(new Error('quota exhausted'), { yt: { kind: YT_API.KIND.QUOTA } });
            remaining -= costUnits;
            return method(params);
        }
    };
    const greetings = { enqueueText: (text) => { replies.push(text); return true; } };
    const router = new YouTubeCommandRouter({ youtube, videoId: 'video-1', liveChatId: 'chat-1',
        ownerId: 'UC_owner', selfId: 'UC_bot', config: {
            moderationEnabled: true, commandPrefix: options.prefix || '!', quotaBudgetPerDay: 10_000,
            moderationQuotaReserve: options.reserve ?? 400, maxModerationActionsPerStream: options.maxActions ?? 25,
            moderationActionCooldownMs: options.cooldown ?? 2_000
        }, greetings, clock: () => now,
        setTimer: (fn, ms) => { const timer = { fn, ms, cleared: false }; timers.push(timer); return timer; },
        clearTimer: (timer) => { if (timer) timer.cleared = true; },
        auditLog: async (entry) => { audits.push(entry); }, onNotice: (message) => notices.push(message), api,
        brain: options.brain || null, discordClient: { channels: {} }, settings: { logChannelId: 'log-channel' }
    });
    const chatter = (channelId, displayName, flags = {}) => router.handleMessage({
        id: `chat-${channelId}-${Math.random()}`, eventType: 'textMessageEvent', text: 'hello chat',
        author: { channelId, displayName, ...flags }
    });
    const ownerCommand = (text) => router.handleMessage({ id: `owner-${Math.random()}`, eventType: 'textMessageEvent', text,
        author: { channelId: 'UC_owner', displayName: 'Owner', isChatOwner: true } });
    async function advance(ms) {
        now += ms;
        const timer = timers.find((candidate) => !candidate.cleared);
        if (timer) { timer.cleared = true; timer.fn(); }
        await new Promise((resolve) => setImmediate(resolve));
    }
    return { router, youtube, calls, replies, audits, notices, timers, chatter, ownerCommand, advance, setRemaining: (n) => { remaining = n; } };
}

test('both owner checks are required; non-owner commands are silent and audited, own channel is never parsed', async () => {
    const h = harness();
    await h.chatter('UC_target', 'Target');
    await h.router.handleMessage({ id: 'wrong-channel', text: '!timeout Target', author: { channelId: 'UC_other', isChatOwner: true } });
    await h.router.handleMessage({ id: 'owner-flag-false', text: '!timeout Target', author: { channelId: 'UC_owner', isChatOwner: false } });
    assert.equal(h.audits.length, 2);
    assert.ok(h.audits.every((entry) => entry.result === 'DENIED'));
    assert.equal(h.audits[0].details.userChannelId, 'UC_other');
    assert.equal(h.replies.length, 0);
    await h.router.handleMessage({ id: 'self-command', text: '!timeout Target', author: { channelId: 'UC_bot', isChatOwner: true } });
    assert.equal(h.audits.length, 2);
    assert.equal(h.calls.bans.length, 0);
});

test('command parsing uses the raw text field instead of YouTube display-formatted text', async () => {
    const h = harness({ cooldown: 0 });
    await h.chatter('UC_target', 'Target');
    await h.router.handleMessage({ id: 'formatted-owner-line', rawText: '!timeout Target', text: 'Owner: !timeout Target',
        eventType: 'textMessageEvent', author: { channelId: 'UC_owner', displayName: 'Owner', isChatOwner: true } });
    assert.equal(h.calls.bans.length, 1);
});

test('missing and ambiguous display names are refused, while exact channel IDs resolve directly', async () => {
    const h = harness();
    await h.chatter('UC_a', 'Same');
    await h.chatter('UC_b', 'Same');
    await h.ownerCommand('!timeout Missing 5');
    assert.match(h.replies.at(-1), /couldn't find a single match/);
    await h.ownerCommand('!timeout Same 5');
    assert.match(h.replies.at(-1), /couldn't find a single match/);
    await h.chatter('UC_exact', 'Exact Viewer');
    await h.ownerCommand('!timeout UC_exact 3 typo');
    assert.equal(h.calls.bans.length, 1);
    assert.equal(h.calls.bans[0].requestBody.snippet.bannedUserDetails.channelId, 'UC_exact');
    assert.equal(h.calls.bans[0].requestBody.snippet.banDurationSeconds, 180);
});

test('owner, bot, and moderator targets are protected; timeout duration is bounded', async () => {
    const h = harness({ cooldown: 0 });
    await h.chatter('UC_owner', 'Owner', { isChatOwner: true });
    await h.chatter('UC_bot', 'ZiGBoT');
    await h.chatter('UC_mod', 'Mod', { isChatModerator: true });
    for (const name of ['Owner', 'ZiGBoT', 'Mod']) await h.ownerCommand(`!timeout ${name}`);
    assert.equal(h.calls.bans.length, 0);
    await h.chatter('UC_target', 'Target');
    await h.ownerCommand('!timeout Target 0 bad duration');
    await h.ownerCommand('!timeout Target 1441 bad duration');
    assert.equal(h.calls.bans.length, 0);
    assert.match(h.replies.at(-1), /1 and 1440/);
    await h.ownerCommand('!timeout Target');
    await h.ownerCommand('!timeout Target 1440');
    assert.deepEqual(h.calls.bans.map((call) => call.requestBody.snippet.banDurationSeconds), [300, 86_400]);
});

test('chatter names strip @/zero-width characters and cache expires after 30 minutes', () => {
    let now = 0;
    const cache = new ChatterCache({ clock: () => now });
    cache.record({ id: 'm1', author: { channelId: 'UC_a', displayName: '\u200b@Viewer\u2060' } });
    assert.equal(normalizeDisplayName('  @Viewer\u200b '), 'viewer');
    assert.equal(cache.findByName('viewer')[0].channelId, 'UC_a');
    now = DEFAULT_RETENTION_MS + 1;
    assert.equal(cache.findByName('viewer').length, 0);
});

test('ban and timeout actions have a short per-stream cooldown', async () => {
    const h = harness();
    await h.chatter('UC_target', 'Target');
    await h.ownerCommand('!timeout Target');
    await h.ownerCommand('!timeout Target');
    assert.equal(h.calls.bans.length, 1);
    assert.match(h.replies.at(-1), /wait a moment/);
    await h.advance(2_000);
    await h.ownerCommand('!timeout Target');
    assert.equal(h.calls.bans.length, 2);
});

test('permanent ban requires confirmation, confirms/cancels/expires with audit records, and rejects another chatter confirmation', async () => {
    const h = harness({ cooldown: 0 });
    await h.chatter('UC_target', 'Target');
    await h.ownerCommand('!ban Target repeated spam');
    assert.equal(h.calls.bans.length, 0);
    assert.match(h.replies.at(-1), /!confirm or !cancel/);
    const unauthorizedConfirm = await h.router.handleMessage({ id: 'other-confirm', text: '!confirm', author: { channelId: 'UC_else', isChatOwner: false } });
    assert.equal(unauthorizedConfirm, true);
    assert.equal(h.calls.bans.length, 0);
    await h.ownerCommand('!confirm');
    assert.equal(h.calls.bans.length, 1);
    assert.equal(h.calls.bans[0].requestBody.snippet.type, 'permanent');
    assert.ok(h.audits.some((entry) => entry.result === 'CONFIRMED'));
    assert.ok(h.audits.some((entry) => entry.result === 'SUCCESS'));

    const cancel = harness();
    await cancel.chatter('UC_target', 'Target');
    await cancel.ownerCommand('!ban Target');
    await cancel.ownerCommand('!cancel');
    assert.equal(cancel.calls.bans.length, 0);
    assert.ok(cancel.audits.some((entry) => entry.result === 'CANCELLED'));

    const expiry = harness();
    await expiry.chatter('UC_target', 'Target');
    await expiry.ownerCommand('!ban Target');
    assert.equal(expiry.timers.find((timer) => !timer.cleared).ms, 30_000);
    await expiry.advance(30_000);
    assert.equal(expiry.calls.bans.length, 0);
    assert.ok(expiry.audits.some((entry) => entry.result === 'EXPIRED'));
});

test('unban only deletes a bot-created ban id and records it for persistence', async () => {
    const saved = new Map();
    const brain = {
        async recordYtBan(videoId, channelId, banId) { saved.set(`${videoId}:${channelId}`, banId); },
        async getYtBanId(videoId, channelId) { return saved.get(`${videoId}:${channelId}`) || null; },
        async deleteYtBan(videoId, channelId) { saved.delete(`${videoId}:${channelId}`); }
    };
    const h = harness({ brain, cooldown: 0 });
    await h.chatter('UC_target', 'Target');
    await h.ownerCommand('!ban Target');
    await h.ownerCommand('!confirm');
    assert.equal(saved.get('video-1:UC_target'), 'ban-1');
    await h.ownerCommand('!unban Target');
    assert.deepEqual(h.calls.unbans, [{ id: 'ban-1' }]);
    assert.equal(saved.has('video-1:UC_target'), false);

    const absent = harness();
    await absent.chatter('UC_unknown', 'Unknown');
    await absent.ownerCommand('!unban UC_unknown');
    assert.equal(absent.calls.unbans.length, 0);
    assert.match(absent.replies.at(-1), /remove it in YouTube Studio/);
});

test('delete caps count at ten and moderation action cap and quota reserve refuse further actions', async () => {
    const del = harness();
    for (let i = 0; i < 12; i += 1) await del.chatter('UC_target', 'Target');
    await del.ownerCommand('!delete Target 99');
    assert.equal(del.calls.deletes.length, 10);

    const capped = harness({ maxActions: 1, cooldown: 0 });
    await capped.chatter('UC_target', 'Target');
    await capped.ownerCommand('!timeout Target');
    await capped.ownerCommand('!timeout Target');
    assert.equal(capped.calls.bans.length, 1);
    assert.ok(capped.audits.some((entry) => entry.details.failureReason === 'per-stream moderation action cap reached'));

    const quota = harness({ remaining: 619 });
    await quota.chatter('UC_target', 'Target');
    await quota.ownerCommand('!timeout UC_target');
    assert.equal(quota.calls.bans.length, 0);
    assert.match(quota.replies.at(-1), /not enough quota/);
});

test('403 moderator failure pauses actions once without throwing', async () => {
    const error = Object.assign(new Error('forbidden: moderator permission required'), { code: 403 });
    const h = harness({ error });
    await h.chatter('UC_target', 'Target');
    await assert.doesNotReject(() => h.ownerCommand('!timeout Target'));
    assert.equal(h.router.active, false);
    assert.equal(h.notices.filter((notice) => notice.includes('not a live-chat moderator')).length, 1);
    const attempted = h.audits.length;
    await h.ownerCommand('!timeout Target');
    assert.equal(h.audits.length, attempted + 1);
    assert.match(h.replies.find((reply) => reply.includes('added as a moderator')), /added as a moderator/);
    await h.router.setEnabled(true, { allowForbiddenRecovery: true });
    assert.equal(h.router.active, true);
});

test('owner-only /ytmod slash gate is registered and runtime changes moderation state', async () => {
    assert.ok(buildDefinitions().some((definition) => definition.name === 'ytmod'));
    orch._seedStateForTests({ config: { quotaBudgetPerDay: 10_000, moderationEnabled: true } });
    const settings = { serverOwnerId: 'discord-owner' };
    const interaction = (id, value) => ({ commandName: 'ytmod', user: { id }, options: { getString: () => value } });
    assert.equal(await runYouTubeInteraction(interaction('not-owner', 'off'), settings), null);
    assert.match(await runYouTubeInteraction(interaction('discord-owner', 'off'), settings), /moderation disabled/);
    assert.equal(orch.getYouTubeStatus().moderation, false);
    orch._resetForTestHarness();
});
