// Section J (Automation): scheduled messages, auto-purge, rules, reminders, events.
const test = require('node:test');
const assert = require('node:assert/strict');
const { PermissionFlagsBits: P } = require('discord.js');
const shared = require('../dashboard/lib/shared');
const { MemoryFeatureStore } = require('../src/features/store');
const { createScheduler } = require('../src/features/scheduler');
const { createAutomation } = require('../src/features/automation');

const G = '900000000000000001';
const U = '111111111111111111';
const V = '222222222222222222';
const CH = '300000000000000001';
const CH2 = '300000000000000002';
const R1 = '400000000000000001';
const ADMIN_ROLE = '400000000000000009';
const HOUR = 3_600_000;

class Coll extends Map {
    find(fn) { for (const v of this.values()) if (fn(v)) return v; return undefined; }
}

function fixture(automation = {}) {
    let t = Date.UTC(2026, 10, 13, 6, 0);
    const audits = [];
    const roleCalls = [];
    const purged = [];
    const events = [];
    const channel = (id) => {
        const sent = [];
        const old = (age, extra = {}) => ({ id: `6${String(age).padStart(17, '0')}`, createdTimestamp: t - age, pinned: false, ...extra });
        return {
            id, guildId: G, sent, isTextBased: () => true,
            send: async (p) => { sent.push(p); return p; },
            messages: { fetch: async () => new Coll([old(2 * HOUR), old(30 * HOUR), old(30 * HOUR + 1, { pinned: true }), old(15 * 24 * HOUR)].map((m) => [m.id, m])) },
            bulkDelete: async (ids) => { purged.push(...ids); return new Coll(ids.map((x) => [x, x])); }
        };
    };
    const role = (id, perms = []) => ({ id, name: id, position: 10, managed: false, permissions: { has: (f) => perms.includes(f) } });
    const roles = new Coll([[R1, role(R1)], [ADMIN_ROLE, role(ADMIN_ROLE, [P.Administrator])]]);
    const member = (id, { has = [], perms = [], bot = false } = {}) => {
        const cache = new Coll(has.map((r) => [r, roles.get(r)]));
        return { id, user: { id, bot }, permissions: { has: (f) => perms.includes(f) }, roles: { cache, add: async (r) => { roleCalls.push(['add', id, r.id]); cache.set(r.id, r); }, remove: async (r) => { roleCalls.push(['remove', id, r.id]); cache.delete(r.id); } } };
    };
    const guild = {
        id: G, name: 'Chill Zone', memberCount: 50,
        channels: { cache: new Coll([[CH, channel(CH)], [CH2, channel(CH2)]]), fetch: async () => null },
        roles: { cache: roles },
        members: { cache: new Coll(), me: { permissions: { has: () => true }, roles: { highest: { position: 40 } } }, fetch: async (id) => guild.members.cache.get(id) || null },
        scheduledEvents: { create: async (e) => { const ev = { id: '700000000000000001', ...e }; events.push(ev); return ev; }, fetch: async () => new Coll(events.map((e) => [e.id, { ...e, scheduledStartTimestamp: e.scheduledStartTime.getTime(), userCount: 3 }])) }
    };
    const config = { enabled: true, feature_settings: shared.defaultFeatureSettings() };
    Object.assign(config.feature_settings.automation, automation);
    const store = new MemoryFeatureStore({ now: () => t });
    const scheduler = createScheduler({ store, now: () => t, logger: { error() {} } });
    const make = () => createAutomation({
        store, scheduler, now: () => t, logger: { error() {} },
        resolveContext: async () => ({ config, settings: {} }),
        auditLog: async (e) => audits.push(e),
        getClient: () => ({ guilds: { cache: new Coll([[G, guild]]) } })
    });
    const automationModule = make();
    const interaction = (sub, { options = {}, who = member(U) } = {}) => {
        const replies = [];
        return { replies, commandName: 'automation', guild, member: who, user: who.user, channel: guild.channels.cache.get(CH),
            options: { getSubcommand: () => sub, getString: (k) => options[k] ?? null, getInteger: (k) => options[k] ?? null },
            reply: async (p) => replies.push(p) };
    };
    return { automation: automationModule, make, scheduler, store, guild, config, audits, roleCalls, purged, events, member, interaction, sent: (id) => guild.channels.cache.get(id).sent, advance: (ms) => { t += ms; } };
}

test('settings: automation is off by default and its lists are validated entry by entry', () => {
    const a = shared.defaultFeatureSettings().automation;
    assert.deepEqual([a.scheduled_messages_enabled, a.auto_purge_enabled, a.rules_enabled, a.events_enabled, a.reminders_enabled], [false, false, false, false, false]);
    const ids = { channelIds: new Set([CH]), roleIds: new Set([R1]), guildId: G };
    const ok = shared.validateFeatureSettings({ automation: { rules_enabled: true, rules: [{ when: 'message', keyword: 'hello', then: 'add_role', role_id: R1 }] } }, ids);
    assert.deepEqual(ok.errors, {});
    assert.equal(ok.value.automation.rules[0].message, '', 'missing sub-fields get their defaults');
    const cases = [
        [{ rules: [{ when: 'message', then: 'add_role', role_id: R1 }] }, /needs a keyword/],
        [{ rules: [{ when: 'join', then: 'send_message', message: 'hi' }] }, /channel to send in/],
        [{ rules: [{ when: 'boom' }] }, /When/],
        [{ rules: Array.from({ length: 26 }, () => ({ when: 'join', then: 'add_role', role_id: R1 })) }, /At most 25/],
        [{ scheduled_messages: [{ channel_id: '399999999999999999', message: 'x' }] }, /not in this server/],
        [{ auto_purge: [{ channel_id: CH, older_than_hours: 999 }] }, /from 1 to 336/],
        [{ rules_enabled: true }, /at least one rule/]
    ];
    for (const [input, pattern] of cases) {
        const result = shared.validateFeatureSettings({ automation: input }, ids);
        assert.match(Object.values(result.errors).join(' '), pattern, JSON.stringify(input).slice(0, 80));
    }
});

test('with automation off, nothing runs and nothing is sent', async () => {
    const f = fixture({ scheduled_messages: [{ channel_id: CH, message: 'x', every_hours: 1 }], rules: [{ when: 'join', keyword: '', emoji: '', if_role_id: null, if_channel_id: null, then: 'send_message', message: 'hi', channel_id: CH, role_id: null }] });
    await f.scheduler.tick();
    await f.automation.onMemberAdd({ ...f.member(U), guild: f.guild });
    assert.equal(await f.automation.onMessage({ guild: f.guild, author: { id: U }, member: f.member(U), channel: f.guild.channels.cache.get(CH), content: 'hi' }), false);
    assert.equal(f.sent(CH).length, 0);
    for (const sub of ['remind', 'event-create', 'events']) {
        const i = f.interaction(sub, { options: { minutes: 5, message: 'x', name: 'x', starts_in_minutes: 5 } });
        await f.automation.handleSlash(i);
        assert.match(i.replies[0].content, /switched off/, sub);
    }
});

test('scheduled messages post once per interval, survive a restart, and never ping', async () => {
    const f = fixture({ scheduled_messages_enabled: true, scheduled_messages: [{ channel_id: CH, message: 'Daily tip for {server} (@everyone)', every_hours: 24 }] });
    await f.scheduler.tick();
    await f.scheduler.tick();
    assert.equal(f.sent(CH).length, 1);
    assert.equal(f.sent(CH)[0].content, 'Daily tip for Chill Zone (@​everyone)');
    assert.deepEqual(f.sent(CH)[0].allowedMentions.parse, []);
    f.make(); // a restarted bot registers its tick on the same storage
    f.advance(23 * HOUR);
    await f.scheduler.tick();
    assert.equal(f.sent(CH).length, 1, 'not again before 24 h, even with two workers');
    f.advance(2 * HOUR);
    await f.scheduler.tick();
    assert.equal(f.sent(CH).length, 2);
});

test('auto-purge deletes only unpinned messages older than the cutoff and younger than 14 days', async () => {
    const f = fixture({ auto_purge_enabled: true, auto_purge: [{ channel_id: CH, older_than_hours: 24, every_hours: 6 }] });
    await f.scheduler.tick();
    assert.deepEqual(f.purged, [`6${String(30 * HOUR).padStart(17, '0')}`]);
    assert.ok(f.audits.some((a) => a.action === 'auto_purge' && a.result === 'SUCCESS' && a.details.deleted === 1));
    await f.scheduler.tick();
    assert.equal(f.purged.length, 1, 'once per interval');
    f.guild.members.me.permissions = { has: () => false };
    f.advance(7 * HOUR);
    await f.scheduler.tick();
    assert.equal(f.purged.length, 1, 'no Manage Messages, no purge');
    assert.ok(f.audits.some((a) => a.action === 'auto_purge' && a.result === 'SKIPPED'));
});

const rule = (r) => ({ keyword: '', emoji: '', if_role_id: null, if_channel_id: null, message: '', channel_id: null, role_id: null, ...r });

test('rules: WHEN join / message / reaction, IF role and channel, THEN message or role', async () => {
    const f = fixture({ rules_enabled: true, rules: [
        rule({ when: 'join', then: 'send_message', message: 'Hi {user}!', channel_id: CH }),
        rule({ when: 'message', keyword: 'verify me', then: 'add_role', role_id: R1, if_channel_id: CH2 }),
        rule({ when: 'reaction', emoji: '✅', then: 'remove_role', role_id: R1, if_role_id: R1 })
    ] });
    await f.automation.onMemberAdd({ ...f.member(U), guild: f.guild });
    assert.equal(f.sent(CH)[0].content, `Hi <@${U}>!`);
    assert.deepEqual(f.sent(CH)[0].allowedMentions, { parse: [], users: [U] });

    const m = f.member(V);
    const say = (channelId, content) => f.automation.onMessage({ guild: f.guild, author: { id: V }, member: m, channel: f.guild.channels.cache.get(channelId), content });
    await say(CH, 'please VERIFY ME');
    assert.deepEqual(f.roleCalls, [], 'wrong channel');
    await say(CH2, 'please VERIFY ME');
    assert.deepEqual(f.roleCalls, [['add', V, R1]]);

    f.guild.members.cache.set(V, m);
    await f.automation.onReaction({ emoji: { name: '✅' }, message: { guild: f.guild, channel: f.guild.channels.cache.get(CH) } }, { id: V, bot: false }, true);
    assert.deepEqual(f.roleCalls, [['add', V, R1], ['remove', V, R1]]);
    assert.ok(f.audits.every((a) => a.details.guild_id === G));
});

test('rules never touch staff roles, never react to bots, and are rate-limited against floods', async () => {
    const f = fixture({ rules_enabled: true, rules: [rule({ when: 'message', keyword: 'hi', then: 'add_role', role_id: ADMIN_ROLE }), rule({ when: 'message', keyword: 'hi', then: 'send_message', message: 'hello' })] });
    const channel = f.guild.channels.cache.get(CH);
    const msg = (id, extra = {}) => ({ guild: f.guild, author: { id, ...extra }, member: f.member(id, extra), channel, content: 'hi' });
    await f.automation.onMessage(msg(U));
    assert.deepEqual(f.roleCalls, []);
    assert.ok(f.audits.some((a) => a.action === 'rule_add_role' && a.result === 'DENIED'));
    for (let i = 0; i < 5; i += 1) await f.automation.onMessage(msg(U));
    assert.equal(channel.sent.length, 1, 'one reply per 10 s per channel');
    await f.automation.onMessage(msg(V, { bot: true }));
    f.advance(11_000);
    await f.automation.onMessage(msg(V, { bot: true }));
    assert.equal(channel.sent.length, 1, 'bots never trigger rules (no bot loops)');
});

test('/automation remind: only pings the member, max 10 waiting per member, survives a restart', async () => {
    const f = fixture({ reminders_enabled: true });
    const set = f.interaction('remind', { options: { minutes: 10, message: 'drink @everyone water' } });
    await f.automation.handleSlash(set);
    assert.match(set.replies[0].content, /remind you here/);
    f.make();
    f.advance(11 * 60_000);
    await f.scheduler.tick();
    assert.deepEqual(f.sent(CH).map((p) => p.content), [`⏰ <@${U}>, reminder: drink @​everyone water`]);
    assert.deepEqual(f.sent(CH)[0].allowedMentions, { parse: [], users: [U] });
    for (let i = 0; i < 10; i += 1) await f.automation.handleSlash(f.interaction('remind', { options: { minutes: 60, message: `r${i}` } }));
    const eleventh = f.interaction('remind', { options: { minutes: 60, message: 'r10' } });
    await f.automation.handleSlash(eleventh);
    assert.match(eleventh.replies[0].content, /already have 10/);
});

test('/automation event-create needs Manage Events from both sides; /automation events lists them', async () => {
    const f = fixture({ events_enabled: true });
    const options = { name: 'Movie night', starts_in_minutes: 120, duration_minutes: 90, location: 'Stage' };
    const denied = f.interaction('event-create', { options });
    await f.automation.handleSlash(denied);
    assert.match(denied.replies[0].content, /Manage Events/);
    await f.automation.handleSlash(f.interaction('event-create', { options, who: f.member(V, { perms: [P.ManageEvents] }) }));
    assert.equal(f.events.length, 1);
    assert.equal(f.events[0].entityMetadata.location, 'Stage');
    assert.equal(f.events[0].scheduledEndTime - f.events[0].scheduledStartTime, 90 * 60_000);
    const list = f.interaction('events');
    await f.automation.handleSlash(list);
    assert.match(list.replies[0].content, /Movie night.*3 interested/);
    assert.ok(f.audits.some((a) => a.action === 'event_create' && a.result === 'SUCCESS'));
    assert.ok(f.audits.some((a) => a.action === 'automation_event-create' && a.result === 'DENIED'));
});

test('/automation rules is admin-only and shows the configured rules', async () => {
    const f = fixture({ rules_enabled: true, rules: [rule({ when: 'message', keyword: 'hi', then: 'add_role', role_id: R1 })] });
    const member = f.interaction('rules');
    await f.automation.handleSlash(member);
    assert.match(member.replies[0].content, /Manage Server/);
    const admin = f.interaction('rules', { who: f.member(V, { perms: [P.ManageGuild] }) });
    await f.automation.handleSlash(admin);
    assert.match(admin.replies[0].content, /1\. WHEN message "hi" THEN add role/);
});

test('src/index.js forwards messages to features inside the existing message listener, after the channel checks', () => {
    const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'src', 'index.js'), 'utf8');
    const listener = src.slice(src.indexOf('client.on(Events.MessageCreate,'));
    const channelCheck = listener.indexOf('channelAllowed(guildCtx.config, message.channel)');
    const hook = listener.indexOf('features.onMessage(message');
    assert.ok(channelCheck > 0 && hook > channelCheck && hook < listener.indexOf('afkHandler.handle(message)'));
});
