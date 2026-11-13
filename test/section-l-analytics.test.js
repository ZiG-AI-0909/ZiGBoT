// Section L: aggregated daily analytics, CSV export, AI report from aggregates only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PermissionFlagsBits: P } = require('discord.js');
const shared = require('../dashboard/lib/shared');
const { analyticsRows, analyticsCsv } = require('../dashboard/lib/shared/analyticsExport');
const { MemoryFeatureStore } = require('../src/features/store');
const { createScheduler } = require('../src/features/scheduler');
const { createAnalytics, summarize } = require('../src/features/analytics');
const { SupabaseTicketStore } = require('../src/tickets/store');

const G = '900000000000000001';
const CH = '300000000000000001';
const CH2 = '300000000000000002';

class Coll extends Map {}

function fixture(enabled = true, { aiAnswer = '- Activity is steady' } = {}) {
    let t = Date.UTC(2026, 10, 13, 6, 0); // 11:30 IST on 2026-11-13
    const aiCalls = [];
    const guild = { id: G };
    const config = { enabled: true, feature_settings: shared.defaultFeatureSettings() };
    config.feature_settings.analytics.analytics_enabled = enabled;
    const store = new MemoryFeatureStore({ now: () => t });
    const scheduler = createScheduler({ store, now: () => t, logger: { error() {} } });
    const analytics = createAnalytics({
        store, scheduler, now: () => t, logger: { error() {} },
        resolveContext: async () => ({ config, settings: {} }),
        auditLog: async () => {},
        getClient: () => ({ guilds: { cache: new Coll([[G, guild]]) } }),
        counters: {
            moderationCases: async () => [{ created_at: new Date(t - 3_600_000).toISOString() }, { created_at: new Date(t - 3 * 86_400_000).toISOString() }],
            securityIncidents: () => [{ createdAt: new Date(t - 60_000).toISOString() }],
            ticketsSince: async () => 2
        },
        aiClient: { chat: { completions: { create: async (body) => { aiCalls.push(body); return { choices: [{ message: { content: aiAnswer } }] }; } } } },
        aiModel: 'm'
    });
    const message = (userId, channelId = CH, content = 'secret plans for saturday') => ({ guild, author: { id: userId, bot: false }, channel: { id: channelId }, content });
    const settle = () => new Promise((r) => setImmediate(r));
    return { analytics, store, scheduler, guild, config, aiCalls, message, settle, advance: (ms) => { t += ms; } };
}

test('settings: analytics is off by default', () => {
    assert.equal(shared.defaultFeatureSettings().analytics.analytics_enabled, false);
});

test('off: nothing is counted or stored', async () => {
    const f = fixture(false);
    f.analytics.observeMessage(f.message('111111111111111111'));
    await f.analytics.onMemberAdd({ guild: f.guild });
    await f.settle();
    await f.scheduler.tick();
    assert.deepEqual(await f.store.list(G, 'analytics'), []);
});

test('daily counts: messages per channel, joins, leaves, distinct active members; never content or ids', async () => {
    const f = fixture();
    for (const [user, channel] of [['111111111111111111', CH], ['111111111111111111', CH], ['222222222222222222', CH2], ['333333333333333333', CH]]) f.analytics.observeMessage(f.message(user, channel));
    f.analytics.observeMessage({ ...f.message('444444444444444444'), author: { id: '444444444444444444', bot: true } });
    await f.analytics.onMemberAdd({ guild: f.guild });
    await f.analytics.onMemberAdd({ guild: f.guild });
    await f.analytics.onMemberRemove({ guild: f.guild });
    await f.settle();
    await f.scheduler.tick();
    const [day] = await f.store.list(G, 'analytics');
    assert.equal(day.key, '2026-11-13', 'the day in the server timezone (Asia/Kolkata)');
    assert.equal(day.data.messages, 4);
    assert.deepEqual(day.data.channels, { [CH]: 3, [CH2]: 1 });
    assert.deepEqual([day.data.joins, day.data.leaves, day.data.active], [2, 1, 3]);
    assert.deepEqual([day.data.moderation, day.data.security, day.data.tickets], [1, 1, 2], 'snapshot counts from the existing stores, last 24 h only');
    const stored = JSON.stringify(await f.store.list(G, 'analytics')) + JSON.stringify([...f.store.rows.values()]);
    assert.doesNotMatch(stored, /secret plans|111111111111111111|222222222222222222/, 'no message content and no member ids are stored');
});

test('counts add up across flushes, active members never go down, and two workers do not double count', async () => {
    const f = fixture();
    f.analytics.observeMessage(f.message('111111111111111111'));
    await f.settle();
    await f.scheduler.tick();
    f.analytics.observeMessage(f.message('111111111111111111'));
    await f.settle();
    await Promise.all([f.scheduler.tick(), f.scheduler.tick()]);
    const [day] = await f.store.list(G, 'analytics');
    assert.equal(day.data.messages, 2);
    assert.equal(day.data.active, 1);
});

test('a new day starts a new record; old records are deleted after 400 days', async () => {
    const f = fixture();
    await f.store.put(G, 'analytics', '2025-01-01', { messages: 5 });
    f.analytics.observeMessage(f.message('111111111111111111'));
    await f.settle();
    await f.scheduler.tick();
    f.advance(86_400_000);
    f.analytics.observeMessage(f.message('111111111111111111'));
    await f.settle();
    f.advance(3_600_001);
    await f.scheduler.tick();
    const keys = (await f.store.list(G, 'analytics')).map((r) => r.key).sort();
    assert.deepEqual(keys, ['2026-11-13', '2026-11-14']);
});

test('summary maths: net growth, leave rate, busiest channels', () => {
    const s = summarize([
        { key: '2026-11-13', data: { joins: 10, leaves: 2, messages: 100, active: 30, channels: { [CH]: 80, [CH2]: 20 }, moderation: 1, security: 0, tickets: 1, event_participants: 4 } },
        { key: '2026-11-12', data: { joins: 0, leaves: 3, messages: 50, active: 40, channels: { [CH2]: 50 } } }
    ]);
    assert.deepEqual([s.net, s.leaveRate, s.peakActive, s.avgMessages], [5, 50, 40, 75]);
    assert.deepEqual(s.topChannels, [[CH, 80], [CH2, 70]]);
});

test('/analytics: off says so, needs Manage Server, AI report gets aggregates only', async () => {
    const off = fixture(false);
    const run = async (f, sub, perms = [P.ManageGuild]) => {
        const replies = [];
        await f.analytics.handleSlash({ replies, guild: f.guild, member: { permissions: { has: (x) => perms.includes(x) } }, user: { id: '1' }, options: { getSubcommand: () => sub, getInteger: () => 7 }, reply: async (p) => replies.push(p) });
        return replies[0].content;
    };
    assert.match(await run(off, 'summary'), /switched off/);
    const f = fixture(true, { aiAnswer: 'Great week @everyone <@123456789012345678>' });
    assert.match(await run(f, 'summary', []), /Manage Server/);
    assert.match(await run(f, 'summary'), /No analytics collected yet/);
    f.analytics.observeMessage(f.message('111111111111111111'));
    await f.settle();
    await f.scheduler.tick();
    assert.match(await run(f, 'summary'), /Messages: 1/);
    const report = await run(f, 'report');
    assert.match(report, /AI report[\s\S]*Great week @​everyone/);
    assert.doesNotMatch(report, /<@123456789012345678>/);
    const sentData = f.aiCalls[0].messages[1].content;
    assert.match(sentData, /^UNTRUSTED_USER_DATA_JSON/);
    assert.doesNotMatch(sentData, new RegExp(CH), 'no channel ids are sent to the AI either');
});

test('CSV export: numbers only, oldest first, formula-safe; bad rows ignored', () => {
    const rows = analyticsRows([
        { key: '2026-11-13', data: { messages: 9, joins: 1, channels: { [CH]: 9 } } },
        { key: '2026-11-12', data: { messages: -5, joins: 'x' } },
        { key: '=cmd|"/c calc"!A1', data: { messages: 1 } },
        { key: '2026-11-11', data: null }
    ], { days: 30 });
    assert.deepEqual(rows.map((r) => r.day), ['2026-11-12', '2026-11-13']);
    assert.deepEqual([rows[0].messages, rows[0].joins], [0, 0]);
    const csv = analyticsCsv(rows);
    assert.match(csv.split('\r\n')[0], /^Date,Joins,Leaves,Messages,Active members/);
    assert.match(csv, new RegExp(`2026-11-13,1,0,9,0,0,0,0,0,${CH}:9`));
    assert.doesNotMatch(csv, /calc/);
});

test('ticket counting is guild-scoped and read-only', async () => {
    const calls = [];
    const store = new SupabaseTicketStore({ supabaseUrl: 'https://db.example', serviceRoleKey: 'k', fetchImpl: async (url, init) => {
        calls.push({ url: decodeURIComponent(url), method: init.method });
        return { ok: true, status: 200, text: async () => JSON.stringify([{ id: 'a', guild_id: G }, { id: 'b', guild_id: '900000000000000002' }]) };
    } });
    assert.equal(await store.countTicketsSince(G, '2026-11-12T00:00:00.000Z'), 1);
    assert.equal(calls[0].method, 'GET');
    assert.match(calls[0].url, new RegExp(`guild_id=eq\\.${G}.*created_at=gte\\.2026-11-12`));
    await assert.rejects(store.countTicketsSince(G, 'nonsense'), /Invalid/);
});

test('dashboard route is admin-verified and pinned to the verified guild; the tab exists', () => {
    const route = fs.readFileSync(path.join(__dirname, '..', 'dashboard', 'app', 'api', 'guilds', '[guildId]', 'analytics', 'route.js'), 'utf8');
    assert.match(route, /await requireGuildAdmin\(guildId\)/);
    assert.match(route, /\.eq\('guild_id', String\(guild\.id\)\)/);
    assert.match(route, /\.eq\('kind', 'analytics'\)/);
    const editor = fs.readFileSync(path.join(__dirname, '..', 'dashboard', 'components', 'GuildEditor.js'), 'utf8');
    assert.match(editor, /<AnalyticsTab guildId=\{initial\.guild\.id\}/);
});

test('src/index.js counts messages first thing in the existing message listener', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');
    const listener = src.slice(src.indexOf('client.on(Events.MessageCreate,'));
    assert.ok(listener.indexOf('features.observeMessage(message)') < listener.indexOf('guildRuntime(message.guild'));
});
