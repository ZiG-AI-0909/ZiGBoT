// Section G (Engagement): XP, economy, trading, games, giveaways, tournaments.
const test = require('node:test');
const assert = require('node:assert/strict');
const { PermissionFlagsBits: P } = require('discord.js');
const shared = require('../dashboard/lib/shared');
const { MemoryFeatureStore } = require('../src/features/store');
const { createScheduler } = require('../src/features/scheduler');
const { createEngagement } = require('../src/features/engagement');
const rules = require('../src/features/engagementRules');

const G = '900000000000000001';
const U = '111111111111111111';
const V = '222222222222222222';
const W = '333333333333333333';
const CH = '300000000000000001';
const IGNORED = '300000000000000009';
const R1 = '400000000000000001';
const ADMIN_ROLE = '400000000000000009';

class Coll extends Map {}

// ----------------------------------------------------------------- rules
test('level formula 5l²+50l+100, with exact level boundaries', () => {
    assert.deepEqual([0, 1, 2, 10].map(rules.xpForLevel), [100, 155, 220, 1100]);
    assert.deepEqual(rules.levelFromXp(99), { level: 0, into: 99, needed: 100 });
    assert.deepEqual(rules.levelFromXp(100), { level: 1, into: 0, needed: 155 });
    assert.deepEqual(rules.levelFromXp(254), { level: 1, into: 154, needed: 155 });
    assert.deepEqual(rules.levelFromXp(255), { level: 2, into: 0, needed: 220 });
    assert.equal(rules.levelFromXp(-5).level, 0);
    assert.equal(rules.rollXp(() => 0), 15);
    assert.equal(rules.rollXp(() => 0.9999), 25);
});

test('brackets: 2-32 players, byes advance automatically, winners build the next round to a champion', () => {
    assert.throws(() => rules.buildBracket(['a']), /2 to 32/);
    assert.throws(() => rules.buildBracket(Array.from({ length: 33 }, (_, i) => `p${i}`)), /2 to 32/);
    const noShuffle = (n) => n - 1; // keeps the order: deterministic test
    const b = rules.buildBracket(['a', 'b', 'c', 'd', 'e'], noShuffle);
    assert.equal(b.rounds[0].length, 4, 'padded to 8 slots');
    assert.equal(b.rounds[0].filter((m) => m.b === null).length, 3, 'three byes');
    assert.ok(b.rounds[0].filter((m) => m.b === null).every((m) => m.winner === m.a));
    const open = b.rounds[0].find((m) => m.winner === null);
    rules.reportWinner(b, open.a);
    assert.equal(b.rounds.length, 2);
    for (const m of [...b.rounds[1]]) rules.reportWinner(b, m.a);
    rules.reportWinner(b, b.rounds[2][0].a);
    assert.ok(b.champion);
    assert.throws(() => rules.reportWinner(b, 'zzz'), /no open match/);
});

test('winners are distinct and drawn from the entrants only', () => {
    const winners = rules.pickWinners(['a', 'b', 'c', 'a'], 5);
    assert.equal(new Set(winners).size, winners.length);
    assert.equal(winners.length, 3);
    assert.deepEqual(rules.pickWinners([], 2), []);
});

test('trivia rounds keep the right answer findable after shuffling; rps rules', () => {
    for (let i = 0; i < 50; i += 1) {
        const round = rules.triviaRound();
        const original = rules.TRIVIA.find((q) => q.question === round.question);
        assert.equal(round.answers[round.correctIndex], original.correct);
    }
    assert.equal(rules.rpsResult('rock', 'scissors'), 'win');
    assert.equal(rules.rpsResult('rock', 'paper'), 'lose');
    assert.equal(rules.rpsResult('paper', 'paper'), 'draw');
});

test('settings: engagement is off by default; shop items are validated', () => {
    const e = shared.defaultFeatureSettings().engagement;
    for (const key of ['xp_enabled', 'economy_enabled', 'achievements_enabled', 'games_enabled', 'giveaways_enabled', 'tournaments_enabled']) assert.equal(e[key], false, key);
    const ids = { channelIds: new Set([CH]), roleIds: new Set([R1]), guildId: G };
    assert.match(Object.values(shared.validateFeatureSettings({ engagement: { shop_items: [{ name: 'Gem', price: 10 }, { name: 'gem ', price: 5 }] } }, ids).errors).join(), /same name/);
    assert.match(Object.values(shared.validateFeatureSettings({ engagement: { shop_items: [{ name: '', price: 10 }] } }, ids).errors).join(), /name/);
    assert.match(Object.values(shared.validateFeatureSettings({ engagement: { daily_amount: 0 } }, ids).errors).join(), /from 1/);
});

// --------------------------------------------------------------- fixture
function fixture(engagement = {}) {
    let t = Date.UTC(2026, 10, 13, 6, 0);
    let roll = 0;
    const audits = [];
    const sent = [];
    const roleCalls = [];
    const channelMessages = new Map();
    const channel = {
        id: CH, guildId: G, isTextBased: () => true,
        send: async (p) => { const m = { id: `70000000000000000${sent.length}`, ...p, edit: async (e) => Object.assign(m, e) }; sent.push(m); channelMessages.set(m.id, m); return m; },
        messages: { fetch: async (id) => channelMessages.get(id) }
    };
    const role = (id, perms = []) => ({ id, name: `role-${id.slice(-1)}`, position: 10, managed: false, permissions: { has: (f) => perms.includes(f) } });
    const guild = {
        id: G, name: 'Chill Zone',
        channels: { cache: new Coll([[CH, channel]]) },
        roles: { cache: new Coll([[R1, role(R1)], [ADMIN_ROLE, role(ADMIN_ROLE, [P.Administrator])]]) },
        members: { me: { permissions: { has: () => true }, roles: { highest: { position: 40 } } } }
    };
    const config = { enabled: true, feature_settings: shared.defaultFeatureSettings() };
    Object.assign(config.feature_settings.engagement, engagement);
    const store = new MemoryFeatureStore({ now: () => t });
    const scheduler = createScheduler({ store, now: () => t, logger: { error() {} } });
    const sequence = [];
    const engagementModule = createEngagement({
        store, scheduler, now: () => t, logger: { error() {} },
        rng: () => roll,
        randomInt: (n) => (sequence.length ? sequence.shift() % n : 0),
        setTimer: () => {},
        renderRankCard: () => Buffer.from('png'),
        resolveContext: async () => ({ config, settings: {} }),
        auditLog: async (e) => audits.push(e),
        getClient: () => ({ guilds: { cache: new Coll([[G, guild]]) } })
    });
    const member = (id, { perms = [], has = [] } = {}) => ({ id, user: { id, bot: false, username: `u${id.slice(0, 2)}` }, permissions: { has: (f) => perms.includes(f) }, roles: { cache: new Coll(has.map((r) => [r, true])), add: async (r) => roleCalls.push(['add', id, r.id]) } });
    const interaction = (commandName, sub, { options = {}, who = member(U), customId = null, message = null } = {}) => {
        const replies = [];
        return {
            replies, commandName, customId, message, guild, member: who, user: who.user, channel,
            options: { getSubcommand: () => sub, getString: (k) => options[k] ?? null, getInteger: (k) => options[k] ?? null, getUser: (k) => options[k] ?? null, getRole: (k) => options[k] ?? null, getMember: () => null },
            reply: async (p) => replies.push(p)
        };
    };
    const say = (id, channelId = CH) => engagementModule.onMessage({ guild, author: { id, bot: false }, channel: { ...channel, id: channelId }, content: 'hi' });
    return { engagement: engagementModule, store, scheduler, guild, config, audits, sent, roleCalls, member, interaction, say, sequence,
        setRoll: (r) => { roll = r; }, advance: (ms) => { t += ms; }, now: () => t, get: async (id) => ({ ...rules.blankMember(), ...(await store.get(G, 'member', id))?.data }) };
}
const text = (i) => i.replies[0].content;

test('with engagement off, messages give no XP and every command says switched off', async () => {
    const f = fixture();
    await f.say(U);
    assert.equal(await f.store.get(G, 'member', U), null);
    for (const [cmd, sub] of [['level', 'rank'], ['eco', 'daily'], ['games', 'trivia'], ['giveaway', 'start'], ['tournament', 'create']]) {
        const i = f.interaction(cmd, sub);
        await f.engagement.handleSlash(i);
        assert.match(text(i), /switched off/, cmd);
    }
});

test('XP: 15-25 per message, once a minute, not in ignored channels, level-up announced once', async () => {
    const f = fixture({ xp_enabled: true, xp_ignored_channel_ids: [IGNORED] });
    f.setRoll(0.9999); // 25 XP
    await f.say(U);
    await f.say(U); // within the cooldown
    assert.equal((await f.get(U)).xp, 25);
    await f.say(U, IGNORED);
    f.advance(61_000);
    await f.say(U, IGNORED);
    assert.equal((await f.get(U)).xp, 25, 'no XP in ignored channels');
    for (let i = 0; i < 3; i += 1) { f.advance(61_000); await f.say(U); }
    const m = await f.get(U);
    assert.equal(m.xp, 100);
    assert.equal(m.messages, 4);
    assert.deepEqual(f.sent.map((s) => s.content), [`🎉 <@${U}> reached **level 1**!`]);
    assert.deepEqual(f.sent[0].allowedMentions, { parse: [], users: [U] });
});

test('XP cooldown holds across two workers (no double count)', async () => {
    const f = fixture({ xp_enabled: true });
    const other = createEngagement({ store: f.store, scheduler: f.scheduler, now: f.now, rng: () => 0, setTimer: () => {}, resolveContext: async () => ({ config: f.config, settings: {} }), auditLog: async () => {}, logger: { error() {} } });
    await Promise.all([f.say(U), other.onMessage({ guild: f.guild, author: { id: U, bot: false }, channel: { id: CH }, content: 'x' })]);
    assert.equal((await f.get(U)).messages, 1);
});

test('rank card and paginated leaderboard', async () => {
    const f = fixture({ xp_enabled: true });
    for (let i = 0; i < 12; i += 1) await f.store.put(G, 'member', `5000000000000000${String(i).padStart(2, '0')}`, { ...rules.blankMember(), xp: i * 100 });
    const page2 = f.interaction('level', 'leaderboard', { options: { page: 2 } });
    await f.engagement.handleSlash(page2);
    assert.match(text(page2), /page 2\/2/);
    assert.match(text(page2), /\*\*11\.\*\*/);
    const rank = f.interaction('level', 'rank', { options: { member: { id: '500000000000000011', username: 'top' } } });
    await f.engagement.handleSlash(rank);
    assert.match(text(rank), /rank #1/);
    assert.equal(rank.replies[0].files[0].name, 'rank.png');
    const { renderRankCard } = require('../src/features/rankCard');
    const png = renderRankCard({ name: 'Star', level: 3, into: 50, needed: 245, rank: 2 });
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
});

test('daily: once per 24 h, streak grows within 48 h and resets after, achievements unlock', async () => {
    const f = fixture({ economy_enabled: true, achievements_enabled: true, daily_amount: 100 });
    const claim = async () => { const i = f.interaction('eco', 'daily'); await f.engagement.handleSlash(i); return text(i); };
    assert.match(await claim(), /streak \*\*1\*\* day/);
    assert.match(await claim(), /already claimed/);
    for (let d = 2; d <= 7; d += 1) { f.advance(25 * 3_600_000); await claim(); }
    const m = await f.get(U);
    assert.equal(m.coins, 700);
    assert.equal(m.streak, 7);
    assert.ok(m.achievements.includes('streak_7'));
    f.advance(50 * 3_600_000);
    assert.match(await claim(), /streak \*\*1\*\* day/, 'missed a day: streak resets');
});

test('shop: buying needs enough coins, adds to the inventory, and never hands out a staff role', async () => {
    const f = fixture({ economy_enabled: true, shop_items: [{ name: 'Gem', price: 50, emoji: '💎', role_id: null }, { name: 'VIP', price: 10, emoji: '⭐', role_id: R1 }, { name: 'Boss', price: 10, emoji: '👑', role_id: ADMIN_ROLE }] });
    await f.store.put(G, 'member', U, { ...rules.blankMember(), coins: 70 });
    const buy = async (item) => { const i = f.interaction('eco', 'buy', { options: { item } }); await f.engagement.handleSlash(i); return text(i); };
    assert.match(await buy('gem'), /You bought/);
    assert.match(await buy('Gem'), /not have enough/);
    assert.match(await buy('VIP'), /role-1 role/);
    assert.match(await buy('Boss'), /cannot hand out/);
    assert.match(await buy('Nope'), /no item/);
    const m = await f.get(U);
    assert.equal(m.coins, 10);
    assert.deepEqual(m.inventory, { Gem: 1, VIP: 1 });
    assert.deepEqual(f.roleCalls, [['add', U, R1]]);
    const inv = f.interaction('eco', 'inventory');
    await f.engagement.handleSlash(inv);
    assert.match(text(inv), /Gem × 1/);
});

test('concurrent purchases never spend coins twice', async () => {
    const f = fixture({ economy_enabled: true, shop_items: [{ name: 'Gem', price: 50, emoji: '💎', role_id: null }] });
    await f.store.put(G, 'member', U, { ...rules.blankMember(), coins: 100 });
    await Promise.all(Array.from({ length: 5 }, () => f.engagement.handleSlash(f.interaction('eco', 'buy', { options: { item: 'Gem' } }))));
    const m = await f.get(U);
    assert.equal(m.coins, 0);
    assert.equal(m.inventory.Gem, 2);
});

test('trading: only the other member can accept, both sides move together, or nothing moves', async () => {
    const f = fixture({ economy_enabled: true, shop_items: [{ name: 'Gem', price: 50, emoji: '💎', role_id: null }] });
    await f.store.put(G, 'member', U, { ...rules.blankMember(), coins: 100 });
    await f.store.put(G, 'member', V, { ...rules.blankMember(), inventory: { Gem: 1 } });
    const offer = f.interaction('eco', 'trade', { options: { member: { id: V, bot: false }, give_coins: 80, want_item: 'Gem' } });
    await f.engagement.handleSlash(offer);
    const post = f.sent[0];
    assert.deepEqual(post.allowedMentions, { parse: [], users: [V] });
    const ids = post.components[0].components.map((b) => b.custom_id);
    const press = async (who, verb) => {
        const id = ids[verb === 'accept' ? 0 : 1];
        const i = f.interaction(null, null, { who: f.member(who), customId: id, message: post });
        await f.engagement.handleComponent(i);
        return text(i);
    };
    assert.match(await press(U, 'accept'), /not yours/, 'the proposer cannot accept for the other side');
    assert.match(await press(W, 'accept'), /not yours/);
    assert.match(await press(V, 'accept'), /Trade complete/);
    assert.deepEqual([(await f.get(U)).coins, (await f.get(U)).inventory.Gem, (await f.get(V)).coins, (await f.get(V)).inventory.Gem], [20, 1, 80, 0]);
    assert.match(await press(V, 'accept'), /already finished/, 'a trade runs once');
});

test('trading: a side that can no longer pay rolls everything back; offers expire', async () => {
    const f = fixture({ economy_enabled: true, shop_items: [{ name: 'Gem', price: 50, emoji: '💎', role_id: null }] });
    await f.store.put(G, 'member', U, { ...rules.blankMember(), coins: 100 });
    await f.store.put(G, 'member', V, { ...rules.blankMember(), inventory: { Gem: 1 } });
    await f.engagement.handleSlash(f.interaction('eco', 'trade', { options: { member: { id: V, bot: false }, give_coins: 80, want_item: 'Gem' } }));
    await f.store.put(G, 'member', V, { ...rules.blankMember(), inventory: { Gem: 0 } }); // V sold the gem meanwhile
    const accept = f.interaction(null, null, { who: f.member(V), customId: f.sent[0].components[0].components[0].custom_id, message: f.sent[0] });
    await f.engagement.handleComponent(accept);
    assert.match(text(accept), /Nothing changed/);
    assert.equal((await f.get(U)).coins, 100, 'proposer refunded');
    assert.equal((await f.get(V)).coins, 0);

    await f.engagement.handleSlash(f.interaction('eco', 'trade', { options: { member: { id: V, bot: false }, give_coins: 10 } }));
    f.advance(6 * 60_000);
    const late = f.interaction(null, null, { who: f.member(V), customId: f.sent[1].components[0].components[0].custom_id, message: f.sent[1] });
    await f.engagement.handleComponent(late);
    assert.match(text(late), /expired/);
    assert.equal((await f.get(U)).coins, 100);

    const self = f.interaction('eco', 'trade', { options: { member: { id: U, bot: false }, give_coins: 1 } });
    await f.engagement.handleSlash(self);
    assert.match(text(self), /not yourself/);
    const broke = f.interaction('eco', 'trade', { options: { member: { id: V, bot: false }, give_coins: 1000 } });
    await f.engagement.handleSlash(broke);
    assert.match(text(broke), /do not have what you are offering/);
});

test('trivia: one answer per member, first right answer wins virtual coins, late clicks refused', async () => {
    const f = fixture({ games_enabled: true, economy_enabled: true, trivia_reward: 25 });
    f.sequence.push(0, 0, 0, 0); // first question, answers kept in a known order
    await f.engagement.handleSlash(f.interaction('games', 'trivia'));
    const post = f.sent[0];
    const buttons = post.components[0].components;
    const correct = buttons.findIndex((b) => b.label === rules.TRIVIA[0].correct);
    const wrong = (correct + 1) % 4;
    const click = async (who, index) => { const i = f.interaction(null, null, { who: f.member(who), customId: buttons[index].custom_id, message: post }); await f.engagement.handleComponent(i); return text(i); };
    assert.match(await click(V, wrong), /Not quite/);
    assert.match(await click(V, correct), /already answered/);
    assert.match(await click(U, correct), /Correct/);
    assert.match(await click(W, correct), /over/);
    assert.equal((await f.get(U)).coins, 25);
    assert.match(post.content, new RegExp(`<@${U}> got it`));
});

test('coinflip and rps answer without betting anything', async () => {
    const f = fixture({ games_enabled: true, economy_enabled: true });
    const flip = f.interaction('games', 'coinflip');
    await f.engagement.handleSlash(flip);
    assert.match(text(flip), /Heads|Tails/);
    f.sequence.push(2); // ZiGBoT picks scissors
    const rps = f.interaction('games', 'rps', { options: { choice: 'rock' } });
    await f.engagement.handleSlash(rps);
    assert.match(text(rps), /You win/);
    assert.equal(await f.store.get(G, 'member', U), null, 'no coins changed hands');
});

test('giveaways: staff only, required role, toggle entry, ends on schedule after a restart, reroll excludes winners', async () => {
    const f = fixture({ giveaways_enabled: true });
    const denied = f.interaction('giveaway', 'start', { options: { prize: 'Nitro', minutes: 10 } });
    await f.engagement.handleSlash(denied);
    assert.match(text(denied), /Manage Server/);
    const staff = f.member(W, { perms: [P.ManageGuild] });
    await f.engagement.handleSlash(f.interaction('giveaway', 'start', { who: staff, options: { prize: 'Nitro', minutes: 10, winners: 1, required_role: { id: R1 } } }));
    const post = f.sent[0];
    const enter = async (who) => { const i = f.interaction(null, null, { who, customId: 'zbg:ga:enter', message: post }); await f.engagement.handleComponent(i); return text(i); };
    assert.match(await enter(f.member(U)), /required role/);
    assert.match(await enter(f.member(U, { has: [R1] })), /You are in/);
    assert.match(await enter(f.member(V, { has: [R1] })), /You are in/);
    assert.match(await enter(f.member(V, { has: [R1] })), /left/);
    assert.match(await enter(f.member(V, { has: [R1] })), /You are in/);

    f.advance(11 * 60_000);
    await f.scheduler.tick(); // the end job is stored, so a restarted bot runs it too
    const record = (await f.store.get(G, 'giveaway', post.id)).data;
    assert.equal(record.ended, true);
    assert.equal(record.winnerIds.length, 1);
    assert.deepEqual(post.components, []);
    const announce = f.sent[1];
    assert.deepEqual(announce.allowedMentions.users, record.winnerIds);
    assert.match(await enter(f.member(U, { has: [R1] })), /ended/);

    const reroll = f.interaction('giveaway', 'reroll', { who: staff, options: { message_id: post.id } });
    await f.engagement.handleSlash(reroll);
    const after = (await f.store.get(G, 'giveaway', post.id)).data;
    assert.notDeepEqual(after.winnerIds, record.winnerIds, 'reroll picks someone else');
    const bad = f.interaction('giveaway', 'end', { who: staff, options: { message_id: 'abc' } });
    await f.engagement.handleSlash(bad);
    assert.match(text(bad), /message ID/);
});

test('tournaments: sign-ups to the cap, bracket on start, winners advance to a champion', async () => {
    const f = fixture({ tournaments_enabled: true });
    const staff = f.member(W, { perms: [P.ManageEvents] });
    await f.engagement.handleSlash(f.interaction('tournament', 'create', { who: staff, options: { name: 'Cup', max_players: 2 } }));
    const post = f.sent[0];
    const join = async (who, action = 'join') => { const i = f.interaction(null, null, { who: f.member(who), customId: `zbg:to:${action}`, message: post }); await f.engagement.handleComponent(i); return text(i); };
    assert.match(await join(U), /signed up/);
    assert.match(await join(U), /already/);
    assert.match(await join(V), /signed up/);
    assert.match(await join(W), /full/);
    const nonStaff = f.interaction('tournament', 'start', { options: { message_id: post.id } });
    await f.engagement.handleSlash(nonStaff);
    assert.match(text(nonStaff), /Manage Events/);
    await f.engagement.handleSlash(f.interaction('tournament', 'start', { who: staff, options: { message_id: post.id } }));
    assert.match(await join(W), /closed/);
    const win = f.interaction('tournament', 'win', { who: staff, options: { message_id: post.id, player: { id: V } } });
    await f.engagement.handleSlash(win);
    const tn = (await f.store.get(G, 'tournament', post.id)).data;
    assert.equal(tn.status, 'finished');
    assert.equal(tn.bracket.champion, V);
    assert.match(f.sent.at(-1).content, new RegExp(`Champion: <@${V}>`));
    const again = f.interaction('tournament', 'win', { who: staff, options: { message_id: post.id, player: { id: V } } });
    await f.engagement.handleSlash(again);
    assert.match(text(again), /not running/);
});

test('member data never leaks across servers', async () => {
    const f = fixture({ economy_enabled: true });
    await f.store.put(G, 'member', U, { ...rules.blankMember(), coins: 999 });
    assert.equal(await f.store.get('900000000000000002', 'member', U), null);
});
