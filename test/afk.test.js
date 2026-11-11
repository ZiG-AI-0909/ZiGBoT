// AFK: "afk <reason>" -> announce, tell people who mention them, welcome
// them back on their next message. Pure logic + the handler with fakes.
const test = require('node:test');
const assert = require('node:assert/strict');
const afk = require('../src/afk/afk');
const { createAfkStore } = require('../src/afk/store');
const { createAfkHandler } = require('../src/afk/handler');

const BOT = '100000000000000000';
const U = '111111111111111111';
const V = '222222222222222222';
const G = '999999999999999999';
const T0 = Date.UTC(2026, 10, 11, 10, 15); // 15:45 IST

// ---------------------------------------------------------------- parsing
test('parseAfkCommand: "afk <reason>" at the start, with or without a bot mention', () => {
    assert.deepEqual(afk.parseAfkCommand('afk I have work', BOT), { reason: 'I have work' });
    assert.deepEqual(afk.parseAfkCommand('AFK   I have work  ', BOT), { reason: 'I have work' });
    assert.deepEqual(afk.parseAfkCommand(`<@${BOT}> afk dinner`, BOT), { reason: 'dinner' });
    assert.deepEqual(afk.parseAfkCommand(`<@!${BOT}> afk`, BOT), { reason: '' });
    assert.deepEqual(afk.parseAfkCommand('afk', BOT), { reason: '' });
    assert.deepEqual(afk.parseAfkCommand('afk\ngoing to sleep', BOT), { reason: 'going to sleep' });
});

test('parseAfkCommand: ignores messages that only contain the word', () => {
    for (const text of ['I will be afk later', 'afkk', 'afk?', 'afk!', '', null, undefined, 'away from keyboard', '<@123456789012345678> afk']) {
        assert.equal(afk.parseAfkCommand(text, BOT), null, String(text));
    }
});

test('cleanReason: no pings, no slurs, short, never empty', () => {
    assert.equal(afk.cleanReason(''), 'AFK');
    assert.equal(afk.cleanReason('   '), 'AFK');
    const pings = afk.cleanReason(`@everyone @here <@${V}> <@!${V}> <@&333333333333333333> meeting`);
    assert.doesNotMatch(pings, /@everyone|@here|<@!?\d+>|<@&\d+>/);
    assert.match(pings, /meeting/);
    assert.equal(afk.cleanReason('x'.repeat(500)).length <= afk.REASON_MAX, true);
    assert.equal(afk.cleanReason('a\n\n\tb'), 'a b');
    // Backticks would open a code block and break the card's layout.
    assert.equal(afk.cleanReason('```code``` **bold**'), "'''code''' **bold**");
});

test('cleanReason: a reason the shared safety filter blocks is hidden', () => {
    // Same filter as every bot reply (dashboard/lib/shared/safety.js).
    assert.equal(afk.cleanReason('kill yourself'), afk.HIDDEN_REASON);
    assert.equal(afk.cleanReason("brb, i'm gonna find you"), afk.HIDDEN_REASON);
    assert.equal(afk.cleanReason('gym, back soon'), 'gym, back soon');
});

// --------------------------------------------------------------- durations
test('formatDuration: plain English, exact to the minute', () => {
    const min = 60_000;
    assert.equal(afk.formatDuration(10_000), 'less than a minute');
    assert.equal(afk.formatDuration(min), '1 minute');
    assert.equal(afk.formatDuration(35 * min), '35 minutes');
    assert.equal(afk.formatDuration(60 * min), '1 hour');
    assert.equal(afk.formatDuration(95 * min), '1 hour 35 minutes');
    assert.equal(afk.formatDuration((2 * 24 * 60 + 3 * 60 + 1) * min), '2 days 3 hours 1 minute');
    assert.equal(afk.formatDuration(-5), 'less than a minute');
    assert.equal(afk.formatDuration(Number.NaN), 'less than a minute');
});

// ---------------------------------------------------------------- messages
const mentionsOf = (text, id) => (text.match(new RegExp(`<@${id}>`, 'g')) || []).length;

test('alert card: tags the user exactly once, reason and local time', () => {
    const msg = afk.alertMessage({ userId: U, reason: 'I have work', since: T0 });
    assert.match(msg.content, /AFK ALERT/);
    assert.match(msg.content, /I have work/);
    assert.match(msg.content, new RegExp(`<t:${T0 / 1000}:t>`), 'Discord shows the time in each reader\'s own timezone');
    assert.equal(mentionsOf(msg.content, U), 1);
    assert.deepEqual(msg.allowedMentions, { parse: [], users: [U], repliedUser: false });
});

test('notification card: tags the AFK user once, shows reason and time away, pings nobody', () => {
    const msg = afk.notifyMessage({ userId: U, reason: 'I have work', since: T0, now: T0 + 35 * 60_000 });
    assert.match(msg.content, /AFK NOTIFICATION/);
    assert.match(msg.content, /35 minutes/);
    assert.match(msg.content, /I have work/);
    assert.equal(mentionsOf(msg.content, U), 1);
    // The person who mentioned them already pinged them; this tag only shows who.
    assert.deepEqual(msg.allowedMentions, { parse: [], users: [], repliedUser: false });
});

test('welcome back card: tags once, report with left/returned/total', () => {
    const back = T0 + 95 * 60_000;
    const msg = afk.welcomeBackMessage({ userId: U, reason: 'I have work', since: T0, now: back });
    assert.match(msg.content, /WELCOME BACK/);
    assert.match(msg.content, /AFK REPORT/);
    assert.match(msg.content, new RegExp(`<t:${T0 / 1000}:t>`));
    assert.match(msg.content, new RegExp(`<t:${back / 1000}:t>`));
    assert.match(msg.content, /1 hour 35 minutes/);
    assert.equal(mentionsOf(msg.content, U), 1);
    assert.deepEqual(msg.allowedMentions, { parse: [], users: [U], repliedUser: false });
});

test('every card stays under Discord\'s 2000-character limit', () => {
    const reason = afk.cleanReason('y'.repeat(5000));
    for (const msg of [afk.alertMessage({ userId: U, reason, since: T0 }), afk.notifyMessage({ userId: U, reason, since: T0, now: T0 }), afk.welcomeBackMessage({ userId: U, reason, since: T0, now: T0 })]) {
        assert.ok(msg.content.length < 2000);
    }
});

test('afkNickname: adds [AFK] within 32 characters, once', () => {
    assert.equal(afk.afkNickname('Star'), 'Star [AFK]');
    assert.equal(afk.afkNickname('x'.repeat(40)).length, 32);
    assert.match(afk.afkNickname('x'.repeat(40)), / \[AFK\]$/);
    assert.equal(afk.afkNickname('Star [AFK]'), 'Star [AFK]');
});

// ------------------------------------------------------------------ store
test('store: survives a restart through the collection', async () => {
    const docs = new Map();
    const collection = {
        find: () => ({ toArray: async () => [...docs.values()] }),
        updateOne: async (filter, update) => { docs.set(`${filter.guildId}:${filter.userId}`, { ...filter, ...update.$set }); },
        deleteOne: async (filter) => { docs.delete(`${filter.guildId}:${filter.userId}`); }
    };
    const first = createAfkStore({ getCollection: () => collection });
    await first.set({ guildId: G, userId: U, reason: 'work', since: T0, originalNick: null, afkNick: null });
    const second = createAfkStore({ getCollection: () => collection });
    await second.load();
    assert.equal(second.get(G, U).reason, 'work');
    await second.remove(G, U);
    assert.equal(second.get(G, U), null);
    assert.equal(docs.size, 0);
});

test('store: works in memory without a database, and a database error never loses the status', async () => {
    const memoryOnly = createAfkStore({ getCollection: () => null });
    await memoryOnly.set({ guildId: G, userId: U, reason: 'r', since: T0 });
    assert.equal(memoryOnly.get(G, U).reason, 'r');
    const broken = createAfkStore({ getCollection: () => ({ updateOne: async () => { throw new Error('db down'); } }), logger: { error() {} } });
    await broken.set({ guildId: G, userId: U, reason: 'r', since: T0 });
    assert.equal(broken.get(G, U).reason, 'r');
});

test('store: AFK in one server is not AFK in another', async () => {
    const store = createAfkStore({ getCollection: () => null });
    await store.set({ guildId: G, userId: U, reason: 'r', since: T0 });
    assert.equal(store.get('888888888888888888', U), null);
});

// ---------------------------------------------------------------- handler
function fakeMessage({ content, authorId = U, mentions = [], nickname = null, displayName = 'Star', manageable = true, canNick = true, ownerId = '777777777777777777' }) {
    const sent = [];
    const nickCalls = [];
    const member = { id: authorId, nickname, displayName, manageable, setNickname: async (nick) => { nickCalls.push(nick); member.nickname = nick; member.displayName = nick || 'Star'; } };
    return {
        sent,
        nickCalls,
        member,
        message: {
            content,
            author: { id: authorId, bot: false },
            member,
            guild: { id: G, ownerId, members: { me: { permissions: { has: () => canNick } } } },
            channel: { id: 'c1', send: async (payload) => { sent.push(payload); } },
            mentions: { users: new Map(mentions.map((id) => [id, { id, bot: id === BOT }])) }
        }
    };
}

function setup(start = T0) {
    let t = start;
    const store = createAfkStore({ getCollection: () => null });
    const handler = createAfkHandler({ store, now: () => t, botId: BOT, logger: { error() {} } });
    return { store, handler, advance: (ms) => { t += ms; } };
}

test('workflow: afk -> mentioned -> returns, fully automatic', async () => {
    const { store, handler, advance } = setup();

    // 1. "afk I have work"
    const goAfk = fakeMessage({ content: 'afk I have work' });
    assert.deepEqual(await handler.handle(goAfk.message), { handled: true });
    assert.equal(store.get(G, U).reason, 'I have work');
    assert.equal(store.get(G, U).since, T0);
    assert.equal(goAfk.sent.length, 1);
    assert.match(goAfk.sent[0].content, /AFK ALERT/);
    assert.deepEqual(goAfk.nickCalls, ['Star [AFK]']);

    // 2. Someone mentions them 35 minutes later.
    advance(35 * 60_000);
    const ping = fakeMessage({ content: `hey <@${U}>`, authorId: V, mentions: [U] });
    assert.deepEqual(await handler.handle(ping.message), { handled: false }, 'the message still goes on to the normal bot flow');
    assert.equal(ping.sent.length, 1);
    assert.match(ping.sent[0].content, /AFK NOTIFICATION/);
    assert.match(ping.sent[0].content, /35 minutes/);

    // 3. They send any message an hour later.
    advance(60 * 60_000);
    const back = fakeMessage({ content: 'hi guys', nickname: 'Star [AFK]', displayName: 'Star [AFK]' });
    assert.deepEqual(await handler.handle(back.message), { handled: false });
    assert.equal(store.get(G, U), null);
    assert.match(back.sent[0].content, /WELCOME BACK/);
    assert.match(back.sent[0].content, /1 hour 35 minutes/);
    assert.deepEqual(back.nickCalls, [null], 'original nickname (none) restored');
});

test('return: restores a custom original nickname, but never overwrites one the user changed meanwhile', async () => {
    const { handler } = setup();
    const go = fakeMessage({ content: 'afk', nickname: 'Captain', displayName: 'Captain' });
    await handler.handle(go.message);
    assert.deepEqual(go.nickCalls, ['Captain [AFK]']);
    const back = fakeMessage({ content: 'back', nickname: 'Captain [AFK]', displayName: 'Captain [AFK]' });
    await handler.handle(back.message);
    assert.deepEqual(back.nickCalls, ['Captain']);

    const { handler: h2 } = setup();
    await h2.handle(fakeMessage({ content: 'afk' }).message);
    const renamed = fakeMessage({ content: 'back', nickname: 'NewName', displayName: 'NewName' });
    await h2.handle(renamed.message);
    assert.deepEqual(renamed.nickCalls, [], 'their own new nickname is kept');
});

test('nickname is skipped when ZiGBoT may not change it (owner, higher role, no permission)', async () => {
    for (const opts of [{ ownerId: U }, { manageable: false }, { canNick: false }]) {
        const { handler, store } = setup();
        const go = fakeMessage({ content: 'afk lunch', ...opts });
        await handler.handle(go.message);
        assert.deepEqual(go.nickCalls, [], JSON.stringify(opts));
        assert.equal(store.get(G, U).afkNick, null);
        assert.match(go.sent[0].content, /AFK ALERT/, 'AFK still works');
    }
});

test('a failed nickname change never stops AFK', async () => {
    const { handler, store } = setup();
    const go = fakeMessage({ content: 'afk lunch' });
    go.member.setNickname = async () => { throw new Error('Missing Permissions'); };
    await handler.handle(go.message);
    assert.equal(store.get(G, U).reason, 'lunch');
    assert.equal(store.get(G, U).afkNick, null);
    assert.equal(go.sent.length, 1);
});

test('typing "afk" again while AFK updates the reason instead of welcoming them back', async () => {
    const { handler, store, advance } = setup();
    await handler.handle(fakeMessage({ content: 'afk lunch' }).message);
    advance(60_000);
    const again = fakeMessage({ content: 'afk actually sleeping', nickname: 'Star [AFK]', displayName: 'Star [AFK]' });
    await handler.handle(again.message);
    assert.equal(store.get(G, U).reason, 'actually sleeping');
    assert.equal(store.get(G, U).since, T0, 'still counts from when they first left');
    assert.doesNotMatch(again.sent.map((m) => m.content).join('\n'), /WELCOME BACK/);
    assert.deepEqual(again.nickCalls, [], 'no [AFK] [AFK]');
});

test('mentions: no spam from repeated pings, at most 3 cards per message, never for bots or yourself', async () => {
    const { handler, store, advance } = setup();
    for (const id of [U, V, '333333333333333333', '444444444444444444']) await store.set({ guildId: G, userId: id, reason: 'r', since: T0 });
    const spam = async () => {
        const m = fakeMessage({ content: 'x', authorId: '555555555555555555', mentions: [U] });
        await handler.handle(m.message);
        return m.sent.length;
    };
    assert.equal(await spam(), 1);
    assert.equal(await spam(), 0, 'same channel, same AFK user, within the cooldown');
    advance(afk.NOTIFY_COOLDOWN_MS + 1);
    assert.equal(await spam(), 1);

    const many = fakeMessage({ content: 'x', authorId: '555555555555555555', mentions: [V, '333333333333333333', '444444444444444444', BOT] });
    advance(afk.NOTIFY_COOLDOWN_MS + 1);
    await handler.handle(many.message);
    assert.equal(many.sent.length, 1, 'one combined message');
    assert.equal(many.sent[0].content.split('AFK NOTIFICATION').length - 1, 3);
});

test('an AFK user mentioning someone else first gets welcomed back, not a notice about themselves', async () => {
    const { handler, store } = setup();
    await store.set({ guildId: G, userId: U, reason: 'r', since: T0 });
    const m = fakeMessage({ content: `<@${U}> me`, mentions: [U] });
    await handler.handle(m.message);
    assert.equal(m.sent.length, 1);
    assert.match(m.sent[0].content, /WELCOME BACK/);
});

test('DMs, bots and system messages are ignored', async () => {
    const { handler, store } = setup();
    const dm = fakeMessage({ content: 'afk' });
    dm.message.guild = null;
    assert.deepEqual(await handler.handle(dm.message), { handled: false });
    const bot = fakeMessage({ content: 'afk' });
    bot.message.author.bot = true;
    assert.deepEqual(await handler.handle(bot.message), { handled: false });
    assert.equal(store.get(G, U), null);
});

test('a failed send never crashes the bot or loses the status', async () => {
    const { handler, store } = setup();
    const m = fakeMessage({ content: 'afk work' });
    m.message.channel.send = async () => { throw new Error('Missing Access'); };
    assert.deepEqual(await handler.handle(m.message), { handled: true });
    assert.equal(store.get(G, U).reason, 'work');
});
