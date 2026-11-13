// Section C (Community) + the shared feature foundation: settings, store, scheduler.
const test = require('node:test');
const assert = require('node:assert/strict');
const { PermissionFlagsBits: P } = require('discord.js');
const shared = require('../dashboard/lib/shared');
const { MemoryFeatureStore, SupabaseFeatureStore } = require('../src/features/store');
const { createScheduler, MAX_PER_GUILD } = require('../src/features/scheduler');
const { createCommunity, renderTemplate, localDate, validBirthday, NUMBER_EMOJI } = require('../src/features/community');
const { createFeatures } = require('../src/features');

const G = '900000000000000001';
const G2 = '900000000000000002';
const BOT = '100000000000000000';
const OWNER = '100000000000000009';
const U = '111111111111111111';
const V = '222222222222222222';
const CH = '300000000000000001';
const CH2 = '300000000000000002';
const R1 = '400000000000000001';
const R2 = '400000000000000002';
const ADMIN_ROLE = '400000000000000009';

class Coll extends Map {
    find(fn) { for (const v of this.values()) if (fn(v)) return v; return undefined; }
    filter(fn) { return [...this.values()].filter(fn); }
}

// ------------------------------------------------------------ settings
test('settings: every optional feature is off by default', () => {
    const defaults = shared.defaultGuildConfig({ guildId: G }).feature_settings;
    for (const [name, section] of Object.entries(defaults)) {
        for (const [key, value] of Object.entries(section)) {
            if (typeof value === 'boolean') assert.equal(value, false, `${name}.${key}`);
        }
    }
    assert.deepEqual(shared.sanitizeStoredConfig({}, { guildId: G }).feature_settings, defaults);
    assert.deepEqual(shared.sanitizeFeatureSettings('garbage'), shared.defaultFeatureSettings());
});

test('settings: ids must belong to the server; a feature needs its channel before it can be on', () => {
    const ids = { channelIds: new Set([CH]), roleIds: new Set([R1]), guildId: G };
    const ok = shared.validateFeatureSettings({ community: { welcome_enabled: true, welcome_channel_id: CH, autorole_enabled: true, autorole_role_ids: [R1] } }, ids);
    assert.deepEqual(ok.errors, {});
    assert.equal(ok.value.community.welcome_channel_id, CH);
    const bad = shared.validateFeatureSettings({ community: { welcome_enabled: true, welcome_channel_id: CH2, autorole_role_ids: [G], starboard_threshold: 0, timezone: 'Mars/Base', welcome_message: 'x'.repeat(2000), suggestions_enabled: true } }, ids);
    for (const key of ['welcome_channel_id', 'autorole_role_ids', 'starboard_threshold', 'timezone', 'welcome_message', 'suggestions_channel_id']) {
        assert.ok(bad.errors[`community.${key}`], key);
    }
    assert.ok(shared.validateFeatureSettings([], ids).errors.feature_settings);
});

test('settings: the full config validator reports feature errors and keeps everything else unchanged', () => {
    const base = shared.defaultGuildConfig({ guildId: G });
    const good = shared.validateGuildConfig({ ...base }, { channelIds: new Set([CH]), roleIds: new Set([R1]), guildId: G });
    assert.equal(good.ok, true, JSON.stringify(good.errors));
    assert.deepEqual(good.value.feature_settings, base.feature_settings);
    const bad = shared.validateGuildConfig({ ...base, feature_settings: { community: { starboard_enabled: true } } }, { channelIds: new Set([CH]), roleIds: new Set([R1]), guildId: G });
    assert.equal(bad.ok, false);
    assert.ok(bad.errors['feature_settings.community.starboard_channel_id']);
});

// --------------------------------------------------------------- store
test('store: records are guild-scoped, create is once-only, and stale updates are refused', async () => {
    const store = new MemoryFeatureStore();
    assert.ok(await store.create(G, 'star', 'm1', { a: 1 }));
    assert.equal(await store.create(G, 'star', 'm1', { a: 2 }), null, 'second create is refused');
    assert.equal(await store.get(G2, 'star', 'm1'), null, 'another server sees nothing');
    assert.deepEqual((await store.list(G2, 'star')), []);
    const first = await store.get(G, 'star', 'm1');
    assert.ok(await store.update(G, 'star', 'm1', first.version, { a: 3 }));
    assert.equal(await store.update(G, 'star', 'm1', first.version, { a: 4 }), null, 'stale version');
    await assert.rejects(store.get('not-an-id', 'star', 'm1'), /guild/);
    await assert.rejects(store.get(G, 'Bad Kind', 'm1'), /kind/);
});

test('store: mutate never loses a concurrent change', async () => {
    const store = new MemoryFeatureStore();
    await store.create(G, 'counter', 'c', { n: 0 });
    await Promise.all(Array.from({ length: 25 }, () => store.mutate(G, 'counter', 'c', async (d) => { await new Promise((r) => setImmediate(r)); d.n += 1; return d; }, { attempts: 100 })));
    assert.equal((await store.get(G, 'counter', 'c')).data.n, 25);
});

test('store (Supabase): every request names the guild, and a foreign row is never returned', async () => {
    const calls = [];
    const store = new SupabaseFeatureStore({
        supabaseUrl: 'https://db.example', serviceRoleKey: 'k',
        fetchImpl: async (url, init) => {
            calls.push({ url, method: init.method, body: init.body });
            return { ok: true, status: 200, text: async () => JSON.stringify([{ guild_id: G2, kind: 'star', key: 'm1', data: {}, version: 1 }]) };
        }
    });
    assert.equal(await store.get(G, 'star', 'm1'), null, 'a row for another guild is dropped');
    assert.deepEqual(await store.list(G, 'star'), []);
    await store.update(G, 'star', 'm1', 1, { x: 1 });
    await store.remove(G, 'star', 'm1');
    for (const call of calls) assert.match(decodeURIComponent(call.url), new RegExp(`guild_id=eq\\.${G}`), call.url);
    assert.match(decodeURIComponent(calls[2].url), /version=eq\.1/);
    assert.equal(new SupabaseFeatureStore({}).enabled, false);
});

// ----------------------------------------------------------- scheduler
test('scheduler: a job runs once when due, survives a restart, and repeats when asked', async () => {
    let t = 1_000_000;
    const store = new MemoryFeatureStore({ now: () => t });
    const ran = [];
    const make = () => {
        const s = createScheduler({ store, now: () => t, logger: { error() {} } });
        s.register('ping', async (job) => { ran.push(job.payload.n); return job.payload.n === 2 && ran.filter((x) => x === 2).length < 2 ? { repeatAt: t + 1000 } : null; });
        return s;
    };
    const first = make();
    await first.schedule(G, 'ping', { n: 1 }, t + 5000);
    await first.tick();
    assert.deepEqual(ran, [], 'not due yet');
    // "Restart": a new scheduler over the same storage.
    const second = make();
    t += 6000;
    await Promise.all([second.tick(), make().tick()]);
    assert.deepEqual(ran, [1], 'two workers, one run');
    await second.tick();
    assert.deepEqual(ran, [1], 'a finished job is gone');
    await second.schedule(G, 'ping', { n: 2 }, t);
    await second.tick();
    t += 2000;
    await second.tick();
    assert.deepEqual(ran, [1, 2, 2], 'repeatAt runs it again');
    await assert.rejects(second.schedule(G, 'nope', {}, t), /Unknown job type/);
});

test('scheduler: a failing job is retried at most 3 times; a server cannot queue without limit', async () => {
    let t = 0;
    const store = new MemoryFeatureStore({ now: () => t });
    const s = createScheduler({ store, now: () => t, logger: { error() {} } });
    let attempts = 0;
    s.register('boom', async () => { attempts += 1; throw new Error('nope'); });
    await s.schedule(G, 'boom', {}, 0);
    for (let i = 0; i < 10; i += 1) { await s.tick(); t += 10 * 60_000; }
    assert.equal(attempts, 3);
    assert.deepEqual(await s.list(G), []);
    s.register('ok', async () => null);
    for (let i = 0; i < MAX_PER_GUILD; i += 1) await store.put(G, 'job', `k${i}`, { type: 'ok', payload: {} }, { dueAt: 9e15 });
    await assert.rejects(s.schedule(G, 'ok', {}, 9e15), /already has/);
});

// ------------------------------------------------------------ helpers
test('templates, local dates and birthdays', () => {
    const guild = { name: '@everyone club', memberCount: 42 };
    const text = renderTemplate('Hi {user}, welcome to {server}! #{memberCount} {user}', { userId: U, guild });
    assert.equal(text, `Hi <@${U}>, welcome to @​everyone club! #42 <@${U}>`);
    // 2026-11-13 20:00 UTC is already the 14th in India, still the 13th in New York.
    const t = Date.UTC(2026, 10, 13, 20, 0);
    assert.deepEqual(localDate(t, 'Asia/Kolkata'), { day: 14, month: 11, date: '2026-11-14' });
    assert.equal(localDate(t, 'America/New_York').day, 13);
    assert.equal(localDate(t, 'Not/AZone').day, 14, 'bad zone falls back to Asia/Kolkata');
    assert.equal(validBirthday(29, 2), true);
    assert.equal(validBirthday(31, 4), false);
    assert.equal(validBirthday(0, 1), false);
});

// ------------------------------------------------------------ fixture
function fixture(overrides = {}) {
    let t = Date.UTC(2026, 10, 13, 6, 0);
    const sent = new Map();
    const audits = [];
    const roleCalls = [];
    const channel = (id, extra = {}) => {
        const list = [];
        sent.set(id, list);
        return { id, guildId: G, type: 0, name: `ch-${id.slice(-1)}`, isTextBased: () => true, send: async (payload) => { const m = { id: `5000000000000000${list.length}${id.slice(-1)}`, ...payload, reactions: [], react: async (e) => m.reactions.push(e), edit: async (p) => Object.assign(m, p) }; list.push(m); return m; }, ...extra };
    };
    const role = (id, name, position, permissions = []) => ({ id, name, position, managed: false, permissions: { has: (flag) => permissions.includes(flag) } });
    const roles = new Coll([[R1, role(R1, 'Gamer', 10)], [R2, role(R2, 'Artist', 11)], [ADMIN_ROLE, role(ADMIN_ROLE, 'Admin', 50, [P.Administrator])]]);
    const member = (id, { bot = false, perms = [], highest = 5, has = [] } = {}) => {
        const cache = new Coll(has.map((r) => [r, roles.get(r)]));
        return {
            id, displayName: `user-${id.slice(0, 3)}`, user: { id, bot, username: `user-${id.slice(0, 3)}` },
            permissions: { has: (flag) => perms.includes(flag) },
            roles: { cache, highest: { position: highest }, add: async (r) => { roleCalls.push(['add', id, r.id]); cache.set(r.id, r); }, remove: async (r) => { roleCalls.push(['remove', id, r.id]); cache.delete(r.id); } }
        };
    };
    const voice = { id: CH2, guildId: G, type: 2, name: 'Members: 0', setName: async (name) => { voice.name = name; voice.renames = (voice.renames || 0) + 1; } };
    const guild = {
        id: G, name: 'Chill Zone', ownerId: OWNER, memberCount: 100, premiumSubscriptionCount: 2,
        channels: { cache: new Coll([[CH, channel(CH)], [CH2, voice]]), fetch: async () => null },
        roles: { cache: roles },
        members: { cache: new Coll(), me: { permissions: { has: () => true }, roles: { highest: { position: 40 } } }, fetch: async (id) => { const m = guild.members.cache.get(id); if (!m) throw new Error('Unknown Member'); return m; } }
    };
    const config = { enabled: true, feature_settings: shared.defaultFeatureSettings() };
    Object.assign(config.feature_settings.community, overrides);
    const store = new MemoryFeatureStore({ now: () => t });
    const scheduler = createScheduler({ store, now: () => t, logger: { error() {} } });
    const community = createCommunity({
        store, scheduler, now: () => t, logger: { error() {} },
        resolveContext: async () => ({ config, settings: {} }),
        auditLog: async (entry) => audits.push(entry),
        getClient: () => ({ guilds: { cache: new Coll([[G, guild]]) } }),
        renderWelcomeImage: () => Buffer.from('png')
    });
    const interaction = (commandName, { sub = null, options = {}, who = member(U), customId = null, message = null, values = [] } = {}) => {
        const replies = [];
        return {
            replies, commandName, customId, values, message, guild, member: who, user: who.user, channel: guild.channels.cache.get(CH),
            options: { getSubcommand: () => sub, getString: (k) => options[k] ?? null, getInteger: (k) => options[k] ?? null, getRole: (k) => options[k] ?? null, getChannel: (k) => options[k] ?? null },
            reply: async (p) => { replies.push(p); }
        };
    };
    return { community, store, scheduler, guild, config, sent, audits, roleCalls, member, interaction, roles, voice, advance: (ms) => { t += ms; }, now: () => t };
}
const last = (list) => list[list.length - 1];

// ----------------------------------------------------- joins and leaves
test('with nothing enabled, joins, leaves, reactions and commands change nothing', async () => {
    const f = fixture();
    await f.community.onMemberAdd({ ...f.member(U), guild: f.guild });
    await f.community.onMemberRemove({ ...f.member(U), guild: f.guild });
    assert.equal(f.sent.get(CH).length, 0);
    assert.deepEqual(f.roleCalls, []);
    assert.equal(f.voice.renames, undefined);
    for (const [name, sub] of [['roles', null], ['suggest', null], ['community', 'birthday'], ['community', 'poll'], ['community', 'announce'], ['community', 'remind']]) {
        const i = f.interaction(name, { sub, options: { type: 'buttons', idea: 'x', day: 1, month: 1 } });
        await f.community.handleSlash(i);
        assert.match(i.replies[0].content, /switched off/, `${name} ${sub}`);
        assert.equal(i.replies[0].ephemeral, true);
    }
    assert.equal(f.sent.get(CH).length, 0);
});

test('welcome: message with the member tagged once, image card, auto-role (bots skipped), milestone once', async () => {
    const f = fixture({ welcome_enabled: true, welcome_channel_id: CH, welcome_image_enabled: true, autorole_enabled: true, autorole_role_ids: [R1, ADMIN_ROLE], milestones_enabled: true });
    await f.community.onMemberAdd({ ...f.member(U), guild: f.guild });
    const [welcome, milestone] = f.sent.get(CH);
    assert.equal(welcome.content, `Welcome <@${U}> to Chill Zone! You are member #100.`);
    assert.deepEqual(welcome.allowedMentions, { parse: [], users: [U] });
    assert.equal(welcome.files[0].name, 'welcome.png');
    assert.match(milestone.content, /100 members/);
    assert.deepEqual(f.roleCalls, [['add', U, R1]], 'the staff role is never auto-assigned');
    assert.ok(f.audits.some((a) => a.action === 'autorole' && a.result === 'SKIPPED' && a.target === ADMIN_ROLE));
    assert.ok(f.audits.every((a) => a.details.guild_id === G && a.event === 'COMMUNITY'));

    await f.community.onMemberAdd({ ...f.member(V, { bot: true }), guild: f.guild });
    assert.equal(f.roleCalls.length, 1, 'bots get no auto-role');
    assert.equal(f.sent.get(CH).filter((m) => /100 members/.test(m.content)).length, 1, 'one milestone post per count');
});

test('goodbye names the member without pinging; the count channel is renamed at most once per 10 minutes', async () => {
    const f = fixture({ goodbye_enabled: true, goodbye_channel_id: CH, member_count_enabled: true, member_count_channel_id: CH2 });
    await f.community.onMemberRemove({ ...f.member(U), guild: f.guild });
    assert.match(last(f.sent.get(CH)).content, new RegExp(`<@${U}> left Chill Zone`));
    assert.deepEqual(last(f.sent.get(CH)).allowedMentions.parse, []);
    assert.equal(last(f.sent.get(CH)).allowedMentions.users, undefined);
    assert.equal(f.voice.name, 'Members: 100');
    f.guild.memberCount = 99;
    await f.community.onMemberRemove({ ...f.member(V), guild: f.guild });
    assert.equal(f.voice.renames, 1, 'throttled');
    f.advance(10 * 60_000 + 1);
    await f.community.onMemberRemove({ ...f.member(V), guild: f.guild });
    assert.equal(f.voice.name, 'Members: 99');
});

test('a server that switched ZiGBoT off gets nothing', async () => {
    const f = fixture({ welcome_enabled: true, welcome_channel_id: CH });
    f.config.enabled = false;
    await f.community.onMemberAdd({ ...f.member(U), guild: f.guild });
    assert.equal(f.sent.get(CH).length, 0);
});

// ------------------------------------------------------------ role panels
test('/roles: staff only, no staff roles on a panel, nothing above the requester', async () => {
    const f = fixture({ role_panels_enabled: true });
    const member = f.interaction('roles', { options: { type: 'buttons', role1: f.roles.get(R1) } });
    await f.community.handleSlash(member);
    assert.match(member.replies[0].content, /Manage Roles/);
    const staff = f.member(V, { perms: [P.ManageRoles], highest: 30 });
    const admin = f.interaction('roles', { who: staff, options: { type: 'buttons', role1: f.roles.get(ADMIN_ROLE) } });
    await f.community.handleSlash(admin);
    assert.match(admin.replies[0].content, /staff permissions/);
    const junior = f.interaction('roles', { who: f.member(V, { perms: [P.ManageRoles], highest: 10 }), options: { type: 'buttons', role1: f.roles.get(R2) } });
    await f.community.handleSlash(junior);
    assert.match(junior.replies[0].content, /at or above your own highest role/);
    assert.equal(f.sent.get(CH).length, 0);
    assert.equal(f.audits.filter((a) => a.result === 'DENIED').length, 3);
});

test('button and dropdown panels toggle only the panel\'s own roles, and are persisted', async () => {
    const f = fixture({ role_panels_enabled: true });
    const staff = f.member(V, { perms: [P.ManageRoles], highest: 30 });
    await f.community.handleSlash(f.interaction('roles', { who: staff, options: { type: 'buttons', title: 'Pick', role1: f.roles.get(R1), role2: f.roles.get(R2) } }));
    const panel = last(f.sent.get(CH));
    assert.equal(panel.components[0].components.length, 2);
    assert.deepEqual((await f.store.get(G, 'role_panel', panel.id)).data.roles, [R1, R2]);

    const user = f.member(U);
    const click = (customId, values) => f.interaction(null, { who: user, customId, message: panel, values });
    const on = click(`zbc:role:${R1}`);
    await f.community.handleComponent(on);
    assert.match(on.replies[0].content, /➕ Gamer/);
    await f.community.handleComponent(click(`zbc:role:${R1}`));
    assert.deepEqual(f.roleCalls, [['add', U, R1], ['remove', U, R1]]);

    // A forged button for a role that is not on this panel does nothing.
    const forged = click(`zbc:role:${ADMIN_ROLE}`);
    await f.community.handleComponent(forged);
    assert.match(forged.replies[0].content, /not part of this panel/);
    // A panel message the bot does not know (deleted record, another server) does nothing.
    const unknown = f.interaction(null, { who: user, customId: `zbc:role:${R1}`, message: { id: '599999999999999999' } });
    await f.community.handleComponent(unknown);
    assert.match(unknown.replies[0].content, /no longer active/);
    assert.equal(f.roleCalls.length, 2);

    await f.community.handleSlash(f.interaction('roles', { who: staff, options: { type: 'dropdown', role1: f.roles.get(R1), role2: f.roles.get(R2) } }));
    const menu = last(f.sent.get(CH));
    await f.community.handleComponent(f.interaction(null, { who: user, customId: 'zbc:roles', message: menu, values: [R2, ADMIN_ROLE] }));
    assert.deepEqual(f.roleCalls.slice(2), [['add', U, R2]], 'values outside the panel are ignored');
});

test('reaction panels add and remove the mapped role; a role that became unsafe is refused', async () => {
    const f = fixture({ role_panels_enabled: true });
    const staff = f.member(V, { perms: [P.ManageRoles], highest: 30 });
    await f.community.handleSlash(f.interaction('roles', { who: staff, options: { type: 'reactions', role1: f.roles.get(R1), role2: f.roles.get(R2) } }));
    const panel = last(f.sent.get(CH));
    assert.deepEqual(panel.reactions, NUMBER_EMOJI.slice(0, 2));
    const user = f.member(U);
    f.guild.members.cache.set(U, user);
    const react = (emoji, added) => f.community.onReaction({ emoji: { name: emoji }, message: { id: panel.id, guild: f.guild, channelId: CH } }, user.user, added);
    await react(NUMBER_EMOJI[1], true);
    await react(NUMBER_EMOJI[1], false);
    assert.deepEqual(f.roleCalls, [['add', U, R2], ['remove', U, R2]]);
    f.roles.get(R1).permissions = { has: (flag) => flag === P.Administrator };
    await react(NUMBER_EMOJI[0], true);
    assert.equal(f.roleCalls.length, 2);
    assert.ok(f.audits.some((a) => a.action === 'role_panel_add' && a.result === 'DENIED'));
    await f.community.onReaction({ emoji: { name: NUMBER_EMOJI[0] }, message: { id: panel.id, guild: f.guild } }, { id: BOT, bot: true }, true);
    assert.equal(f.roleCalls.length, 2, 'bot reactions are ignored');
});

// -------------------------------------------------------------- starboard
test('starboard: 3 stars from other humans, once per message, never for bots or from its own channel', async () => {
    const f = fixture({ starboard_enabled: true, starboard_channel_id: CH });
    const star = (users, message) => f.community.onReaction({ emoji: { name: '⭐' }, message, users: { fetch: async () => new Coll(users.map((u) => [u.id, u])) } }, { id: V, bot: false }, true);
    const msg = { id: '700000000000000001', guild: f.guild, channelId: '300000000000000005', author: { id: U, bot: false }, content: 'great @everyone post', url: 'https://discord.com/x', attachments: new Coll() };
    const humans = (n) => Array.from({ length: n }, (_, i) => ({ id: `80000000000000000${i}`, bot: false }));
    await star([...humans(2), { id: U, bot: false }, { id: BOT, bot: true }], msg);
    assert.equal(f.sent.get(CH).length, 0, 'the author and bots do not count');
    await star(humans(3), msg);
    await star(humans(5), msg);
    assert.equal(f.sent.get(CH).length, 1, 'posted once');
    assert.match(f.sent.get(CH)[0].content, /⭐ \*\*3\*\*/);
    assert.doesNotMatch(f.sent.get(CH)[0].content, /@everyone/);
    await star(humans(3), { ...msg, id: '700000000000000002', author: { id: BOT, bot: true } });
    await star(humans(3), { ...msg, id: '700000000000000003', channelId: CH });
    assert.equal(f.sent.get(CH).length, 1);
});

// ------------------------------------------------------------ suggestions
test('/suggest: one vote per member, staff-only decisions, closed suggestions stay closed', async () => {
    const f = fixture({ suggestions_enabled: true, suggestions_channel_id: CH });
    await f.community.handleSlash(f.interaction('suggest', { options: { idea: 'Add a @everyone movie night' } }));
    const post = last(f.sent.get(CH));
    assert.match(post.content, /movie night/);
    assert.doesNotMatch(post.content, /@everyone/);
    const press = async (customId, who) => { const i = f.interaction(null, { who, customId, message: post }); await f.community.handleComponent(i); return i; };
    await press('zbc:sv:up', f.member(U));
    await press('zbc:sv:up', f.member(V));
    await press('zbc:sv:down', f.member(V)); // V moves the vote
    await press('zbc:sv:up', f.member(U)); // U takes the vote back
    let data = (await f.store.get(G, 'suggestion', post.id)).data;
    assert.deepEqual([data.up, data.down], [[], [V]]);
    assert.match(post.content, /👍 0 · 👎 1/);

    const refused = await press('zbc:sd:approved', f.member(U));
    assert.match(refused.replies[0].content, /Only staff/);
    await press('zbc:sd:approved', f.member(V, { perms: [P.ManageMessages] }));
    data = (await f.store.get(G, 'suggestion', post.id)).data;
    assert.equal(data.status, 'approved');
    assert.deepEqual(post.components, []);
    const late = await press('zbc:sv:up', f.member(U));
    assert.match(late.replies[0].content, /already closed/);
});

test('suggestion votes are not lost when many members vote at once', async () => {
    const f = fixture({ suggestions_enabled: true, suggestions_channel_id: CH });
    await f.community.handleSlash(f.interaction('suggest', { options: { idea: 'x' } }));
    const post = last(f.sent.get(CH));
    await Promise.all(Array.from({ length: 5 }, (_, i) => f.community.handleComponent(f.interaction(null, { who: f.member(`81000000000000000${i}`), customId: 'zbc:sv:up', message: post }))));
    assert.equal((await f.store.get(G, 'suggestion', post.id)).data.up.length, 5);
});

// ---------------------------------------------------------- /community
test('birthdays: day and month only, posted once per local day, only for members still here', async () => {
    const f = fixture({ birthdays_enabled: true, birthday_channel_id: CH });
    const bad = f.interaction('community', { sub: 'birthday', options: { day: 31, month: 2 } });
    await f.community.handleSlash(bad);
    assert.match(bad.replies[0].content, /not a real date/);
    await f.community.handleSlash(f.interaction('community', { sub: 'birthday', options: { day: 13, month: 11 } }));
    await f.community.handleSlash(f.interaction('community', { sub: 'birthday', who: f.member(V), options: { day: 13, month: 11 } }));
    assert.deepEqual((await f.store.get(G, 'birthday', U)).data, { day: 13, month: 11 }, 'no year is stored');
    f.guild.members.cache.set(U, f.member(U)); // V has left the server
    await f.community.birthdayPosts(f.now());
    await f.community.birthdayPosts(f.now());
    const posts = f.sent.get(CH);
    assert.equal(posts.length, 1);
    assert.equal(posts[0].content, `🎂 Happy birthday <@${U}>! 🎉`);
    assert.deepEqual(posts[0].allowedMentions.users, [U]);
    await f.community.handleSlash(f.interaction('community', { sub: 'birthday-remove' }));
    assert.equal(await f.store.get(G, 'birthday', U), null);
});

test('polls, announcements and reminders are staff-only and never ping', async () => {
    const f = fixture({ polls_enabled: true, announcements_enabled: true });
    const staff = f.member(V, { perms: [P.ManageMessages] });
    for (const sub of ['poll', 'announce', 'remind']) {
        const i = f.interaction('community', { sub, options: { question: 'q', options: 'a|b', message: 'm', minutes: 5 } });
        await f.community.handleSlash(i);
        assert.match(i.replies[0].content, /Only staff/, sub);
    }
    assert.equal(f.audits.filter((a) => a.result === 'DENIED').length, 3);
    assert.equal(f.sent.get(CH).length, 0);

    await f.community.handleSlash(f.interaction('community', { sub: 'poll', who: staff, options: { question: 'Lunch?', options: 'Pizza | Burger | Pizza |  ', hours: 2 } }));
    assert.deepEqual(last(f.sent.get(CH)).poll, { question: { text: 'Lunch?' }, answers: [{ text: 'Pizza' }, { text: 'Burger' }], duration: 2, allowMultiselect: false });
    const one = f.interaction('community', { sub: 'poll', who: staff, options: { question: 'Lunch?', options: 'Pizza' } });
    await f.community.handleSlash(one);
    assert.match(one.replies[0].content, /2 to 10 options/);

    await f.community.handleSlash(f.interaction('community', { sub: 'announce', who: staff, options: { message: 'Event at 8 @everyone' } }));
    assert.equal(last(f.sent.get(CH)).content, '📢 Event at 8 @​everyone');
    assert.deepEqual(last(f.sent.get(CH)).allowedMentions.parse, []);
});

test('reminder: stored, posted when due (also after a restart), and dropped if the feature was switched off', async () => {
    const f = fixture({ announcements_enabled: true });
    const staff = f.member(V, { perms: [P.ManageMessages] });
    const set = f.interaction('community', { sub: 'remind', who: staff, options: { minutes: 30, message: 'Stand-up' } });
    await f.community.handleSlash(set);
    assert.match(set.replies[0].content, /Reminder set/);
    await f.scheduler.tick();
    assert.equal(f.sent.get(CH).length, 0);
    f.advance(31 * 60_000);
    await f.scheduler.tick();
    await f.scheduler.tick();
    assert.deepEqual(f.sent.get(CH).map((m) => m.content), ['⏰ **Reminder:** Stand-up']);

    await f.community.handleSlash(f.interaction('community', { sub: 'remind', who: staff, options: { minutes: 1, message: 'Later' } }));
    f.config.feature_settings.community.announcements_enabled = false;
    f.advance(2 * 60_000);
    await f.scheduler.tick();
    assert.equal(f.sent.get(CH).length, 1, 'not posted once the feature is off');
    const tooFar = f.interaction('community', { sub: 'remind', who: staff, options: { minutes: 99999999, message: 'x' } });
    f.config.feature_settings.community.announcements_enabled = true;
    await f.community.handleSlash(tooFar);
    assert.match(tooFar.replies[0].content, /Minutes must be/);
});

test('/community stats works for everyone and reports real counts', async () => {
    const f = fixture();
    const i = f.interaction('community', { sub: 'stats' });
    await f.community.handleSlash(i);
    assert.match(i.replies[0].content, /Members: 100/);
    assert.match(i.replies[0].content, /Text channels: 1 · Voice channels: 1/);
    assert.match(i.replies[0].content, /Roles: 3 · Boosts: 2/);
});

// ----------------------------------------------------------- integration
test('welcome image is a real PNG of the expected size', () => {
    const { renderWelcomeImage, WIDTH, HEIGHT } = require('../src/features/welcomeImage');
    const png = renderWelcomeImage({ name: 'A very long member name that must still fit on the card', server: 'Chill Zone', memberCount: 1234 });
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    assert.equal(png.readUInt32BE(16), WIDTH);
    assert.equal(png.readUInt32BE(20), HEIGHT);
});

test('createFeatures routes events and commands, and a failing module never throws', async () => {
    const features = createFeatures({ resolveContext: async () => { throw new Error('config down'); }, auditLog: async () => {}, getClient: () => null, logger: { error() {} } });
    assert.equal(features.store.persistent, false, 'no Supabase configured: in-memory');
    await features.onMemberAdd({ id: U, guild: { id: G } });
    await features.onMemberRemove({ id: U, guild: { id: G } });
    await features.onReaction({ emoji: { name: '⭐' }, message: { guild: { id: G } } }, { id: U }, true);
    assert.equal(await features.onMessage({}, {}), false);
    assert.equal(features.handlesSlash({ commandName: 'community' }), true);
    assert.equal(features.handlesSlash({ commandName: 'play' }), false);
    assert.equal(features.isComponent({ customId: 'zbc:sv:up' }), true);
    assert.equal(features.isComponent({ customId: 'music:pause' }), false);
});

test('src/index.js: one listener per event, with the features hooked into the existing member-join listener', () => {
    const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'src', 'index.js'), 'utf8');
    for (const event of ['GuildMemberAdd', 'GuildMemberRemove', 'MessageReactionAdd', 'MessageReactionRemove', 'InteractionCreate', 'MessageCreate', 'VoiceStateUpdate']) {
        assert.equal(src.split(`client.on(Events.${event},`).length - 1, 1, event);
    }
    const join = src.slice(src.indexOf('client.on(Events.GuildMemberAdd,'));
    assert.ok(join.indexOf('features.onMemberAdd(member)') < join.indexOf('});'));
});
