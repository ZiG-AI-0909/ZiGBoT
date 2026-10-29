const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { AuditLogEvent, PermissionFlagsBits, ChannelType } = require('discord.js');

const { createEngine, normalizeAuditEntry, TRUSTED_CRITICAL_MULTIPLIER } = require('../src/antinuke/engine');
const { buildAlert } = require('../src/antinuke/alerts');
const { runContainment } = require('../src/antinuke/containment');
const { createAntiNukeStore } = require('../src/antinuke/store');
const { createAntiNuke, ALERTS_PER_WINDOW } = require('../src/antinuke/monitor');
const {
    sanitizeAntiNukeSettings, validateAntiNukeSettings, missingPermissions, defaultAntiNukeSettings, ANTINUKE_RULES
} = require('../dashboard/lib/shared/antinuke');

// Anti-Nuke. Discord and Supabase are faked here: these tests prove the
// detection, alert, containment and storage logic, not live Discord behaviour.

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\r\n/g, '\n');
const G = '900000000000000001';
const G2 = '900000000000000002';
const OWNER = '100000000000000001';
const BOT = '100000000000000009'; // ZiGBoT
const MOD = '100000000000000002';
const ROGUE = '100000000000000003';
const NEWBOT = '100000000000000004';
const ADMIN_BITS = String(PermissionFlagsBits.Administrator);

const settings = (overrides = {}) => sanitizeAntiNukeSettings({ ...defaultAntiNukeSettings(G), ...overrides }, G);
const ctx = (extra = {}) => ({ guildId: G, ownerId: OWNER, botId: BOT, ...extra });
const entry = (action, executorId, extra = {}) => ({ action, executorId, targetId: extra.targetId || String(Math.floor(Math.random() * 1e17) + 1e17), changes: extra.changes || [], extra: extra.extra });
function engineAt(start = 1_000_000) {
    const clock = { t: start };
    return { engine: createEngine({ now: () => clock.t }), clock };
}
const run = (engine, e, s = settings(), c = ctx()) => engine.process(normalizeAuditEntry(e, { now: Date.now() }), s, c);

// ---------- detection ----------

test('1. normal maintenance does not raise critical alerts', () => {
    const { engine } = engineAt();
    const found = [
        ...run(engine, entry(AuditLogEvent.ChannelDelete, MOD)),
        ...run(engine, entry(AuditLogEvent.RoleDelete, MOD)),
        ...run(engine, entry(AuditLogEvent.ChannelCreate, MOD)),
        ...run(engine, entry(AuditLogEvent.RoleUpdate, MOD, { changes: [{ key: 'color', old: 1, new: 2 }] })),
        ...run(engine, entry(AuditLogEvent.RoleUpdate, MOD, { changes: [{ key: 'permissions', old: '0', new: String(PermissionFlagsBits.SendMessages) }] })),
        ...run(engine, entry(AuditLogEvent.MemberBanAdd, MOD)),
        ...run(engine, entry(AuditLogEvent.WebhookCreate, MOD))
    ];
    assert.deepEqual(found, [], 'single or harmless actions never alert');
});

test('2. a rapid destructive burst is CRITICAL, and needs the burst (window-based)', () => {
    const { engine, clock } = engineAt();
    for (let i = 0; i < 3; i += 1) assert.deepEqual(run(engine, entry(AuditLogEvent.ChannelDelete, ROGUE)), []);
    const [incident] = run(engine, entry(AuditLogEvent.RoleDelete, ROGUE));
    assert.equal(incident.rule, 'mass_delete');
    assert.equal(incident.severity, 'CRITICAL');
    assert.equal(incident.count, 4);
    assert.equal(incident.targetIds.length, 4);
    assert.equal(incident.delivery, 'new');
    // The same pace spread beyond the window does not alert.
    const slow = engineAt();
    for (let i = 0; i < 6; i += 1) {
        assert.deepEqual(run(slow.engine, entry(AuditLogEvent.ChannelDelete, MOD)), []);
        slow.clock.t += 61_000;
    }
    clock.t += 1;
});

test('3. administrator and dangerous permission grants are detected', () => {
    const { engine } = engineAt();
    const [admin] = run(engine, entry(AuditLogEvent.RoleUpdate, ROGUE, { changes: [{ key: 'permissions', old: '0', new: ADMIN_BITS }] }));
    assert.equal(admin.rule, 'admin_grant');
    assert.equal(admin.severity, 'HIGH');
    // Member given a role that has Ban Members: MEDIUM.
    const roles = { '700000000000000001': PermissionFlagsBits.BanMembers };
    const member = normalizeAuditEntry(entry(AuditLogEvent.MemberRoleUpdate, MOD, { changes: [{ key: '$add', new: [{ id: '700000000000000001', name: 'Mods' }] }] }), { rolePermissions: (id) => roles[id] ?? 0n });
    const [grant] = engine.process(member, settings(), ctx());
    assert.equal(grant.rule, 'dangerous_grant');
    assert.deepEqual(grant.permissions, ['Ban Members']);
    // A role gaining harmless permissions is not a grant.
    assert.equal(normalizeAuditEntry(entry(AuditLogEvent.MemberRoleUpdate, MOD, { changes: [{ key: '$add', new: [{ id: '7', name: 'x' }] }] }), { rolePermissions: () => PermissionFlagsBits.SendMessages }), null);
    // Grant then destruction by the same account: CRITICAL correlation.
    run(engine, entry(AuditLogEvent.ChannelDelete, ROGUE));
    const correlated = run(engine, entry(AuditLogEvent.ChannelDelete, ROGUE));
    assert.ok(correlated.some((i) => i.rule === 'permission_then_destroy' && i.severity === 'CRITICAL'));
});

test('4. a bot added with powerful permissions by an untrusted account alerts; owner additions do not', () => {
    const { engine } = engineAt();
    const [high] = engine.process(normalizeAuditEntry(entry(AuditLogEvent.BotAdd, MOD, { targetId: NEWBOT })), settings(), ctx({ botPermissions: PermissionFlagsBits.Administrator }));
    assert.equal(high.rule, 'bot_added_admin');
    assert.equal(high.severity, 'HIGH');
    assert.equal(high.botId, NEWBOT);
    const [medium] = createEngine().process(normalizeAuditEntry(entry(AuditLogEvent.BotAdd, MOD, { targetId: NEWBOT })), settings(), ctx({ botPermissions: PermissionFlagsBits.ManageChannels }));
    assert.equal(medium.rule, 'bot_added_elevated');
    assert.deepEqual(createEngine().process(normalizeAuditEntry(entry(AuditLogEvent.BotAdd, MOD, { targetId: NEWBOT })), settings(), ctx({ botPermissions: PermissionFlagsBits.SendMessages })), [], 'a harmless bot is fine');
    assert.deepEqual(createEngine().process(normalizeAuditEntry(entry(AuditLogEvent.BotAdd, OWNER, { targetId: NEWBOT })), settings(), ctx({ botPermissions: PermissionFlagsBits.Administrator })), [], 'the owner adding a bot is not flagged');
});

test('5. repeats are suppressed inside the cooldown; growth in severity escalates', () => {
    const { engine, clock } = engineAt();
    for (let i = 0; i < 3; i += 1) run(engine, entry(AuditLogEvent.ChannelDelete, ROGUE));
    assert.equal(run(engine, entry(AuditLogEvent.ChannelDelete, ROGUE))[0].delivery, 'new');
    assert.equal(run(engine, entry(AuditLogEvent.ChannelDelete, ROGUE))[0].delivery, 'suppressed');
    assert.equal(run(engine, entry(AuditLogEvent.ChannelDelete, ROGUE))[0].delivery, 'suppressed');
    clock.t += 11 * 60_000; // past the 10 minute cooldown
    for (let i = 0; i < 3; i += 1) run(engine, entry(AuditLogEvent.ChannelDelete, ROGUE));
    assert.equal(run(engine, entry(AuditLogEvent.ChannelDelete, ROGUE))[0].delivery, 'new');
    // MEDIUM ban burst growing into CRITICAL: a second, louder alert.
    const mod = engineAt();
    const results = [];
    for (let i = 0; i < 5; i += 1) results.push(...run(mod.engine, entry(AuditLogEvent.MemberBanAdd, MOD)));
    assert.deepEqual(results.map((r) => `${r.rule}:${r.delivery}`), ['mod_burst:new', 'mod_burst:suppressed', 'mass_removal:escalated']);
});

test('10. trusted accounts and maintenance skip routine alerts, but extreme bursts still alert', () => {
    const s = settings({ trusted_user_ids: [MOD] });
    const { engine } = engineAt();
    for (let i = 0; i < 4 * TRUSTED_CRITICAL_MULTIPLIER - 1; i += 1) assert.deepEqual(run(engine, entry(AuditLogEvent.ChannelDelete, MOD), s), [], `delete ${i + 1}`);
    assert.deepEqual(run(engine, entry(AuditLogEvent.RoleUpdate, MOD, { changes: [{ key: 'permissions', old: '0', new: ADMIN_BITS }] }), s), [], 'trusted admin grant is maintenance');
    const [extreme] = run(engine, entry(AuditLogEvent.ChannelDelete, MOD), s);
    assert.equal(extreme.rule, 'mass_delete');
    assert.match(extreme.reason, /raised for a trusted account/);
    // Maintenance mode: everyone trusted until it ends.
    const maint = engineAt(Date.parse('2026-10-29T10:00:00Z'));
    const window = settings({ maintenance_until: '2026-10-29T11:00:00Z' });
    for (let i = 0; i < 6; i += 1) assert.deepEqual(run(maint.engine, entry(AuditLogEvent.ChannelDelete, ROGUE), window), []);
    // The owner is also treated as trusted (but never ignored).
    const owner = engineAt();
    for (let i = 0; i < 11; i += 1) assert.deepEqual(run(owner.engine, entry(AuditLogEvent.ChannelDelete, OWNER)), []);
    assert.equal(run(owner.engine, entry(AuditLogEvent.ChannelDelete, OWNER))[0].rule, 'mass_delete');
    // ZiGBoT's own containment actions are never judged.
    const self = engineAt();
    for (let i = 0; i < 20; i += 1) assert.deepEqual(run(self.engine, entry(AuditLogEvent.MemberKick, BOT)), []);
});

test('join bursts alert once per cooldown, per server', () => {
    const { engine } = engineAt();
    const join = { type: 'member_join', actorId: null, targetId: null, at: 1_000_000, count: 1 };
    const results = [];
    for (let i = 0; i < 12; i += 1) results.push(...engine.process({ ...join }, settings(), ctx()));
    assert.equal(results.filter((r) => r.delivery === 'new').length, 1);
    assert.equal(results[0].rule, 'join_burst');
    assert.deepEqual(engine.process({ ...join }, settings(), ctx({ guildId: G2 })), [], 'another server has its own counters');
});

// ---------- alerts ----------

const guildInfo = { id: G, name: 'Example *Community*', ownerId: OWNER };
const criticalIncident = { rule: 'mass_delete', severity: 'CRITICAL', actorId: ROGUE, count: 5, targetIds: ['1', '2'], reason: '5 channels/roles deleted…', delivery: 'new' };

test('6. alerts mention only configured recipients', () => {
    const all = buildAlert({ incident: criticalIncident, guild: guildInfo, settings: settings({ staff_role_id: '800000000000000001', everyone_on_critical: true }) });
    assert.deepEqual(all.allowedMentions, { parse: ['everyone'], users: [OWNER], roles: ['800000000000000001'] });
    assert.match(all.content, /@everyone/);
    assert.ok(!all.allowedMentions.users.includes(ROGUE), 'the actor is shown but never pinged');
    // @everyone off by default; MEDIUM never pings staff or everyone.
    const quiet = buildAlert({ incident: criticalIncident, guild: guildInfo, settings: settings({ staff_role_id: '800000000000000001' }) });
    assert.deepEqual(quiet.allowedMentions.parse, []);
    const medium = buildAlert({ incident: { ...criticalIncident, rule: 'mod_burst', severity: 'MEDIUM' }, guild: guildInfo, settings: settings({ staff_role_id: '800000000000000001', everyone_on_critical: true }) });
    assert.deepEqual(medium.allowedMentions, { parse: [], users: [OWNER], roles: [] });
    const noOwner = buildAlert({ incident: criticalIncident, guild: guildInfo, settings: settings({ notify_owner: false }) });
    assert.deepEqual(noOwner.allowedMentions.users, []);
    // Content: severity, server, actor, reason, guidance; always under Discord's limit.
    assert.match(all.content, /CRITICAL SECURITY ALERT/);
    assert.match(all.content, /\*\*Server:\*\* Example Community/);
    assert.match(all.content, new RegExp(`<@${ROGUE}> \\(\`${ROGUE}\`\\)`));
    assert.match(all.content, /Discord cannot restore deleted channels or roles, and neither can ZiGBoT/);
    for (const rule of Object.keys(ANTINUKE_RULES)) {
        const alert = buildAlert({ incident: { ...criticalIncident, rule, severity: ANTINUKE_RULES[rule].severity, targetIds: Array(50).fill('123456789012345678') }, guild: guildInfo, settings: settings(), dashboardUrl: 'https://zigbotai.vercel.app/dashboard/1' });
        assert.ok(alert.content.length <= 2000, rule);
    }
});

// ---------- containment ----------

function fakeGuild({ mePerms = [PermissionFlagsBits.ManageRoles, PermissionFlagsBits.KickMembers], meTop = 10, members = {}, removeMode = 'ok' } = {}) {
    const calls = [];
    const me = { id: BOT, permissions: { has: (bit) => mePerms.includes(bit), bitfield: mePerms.reduce((a, b) => a | b, 0n) }, roles: { highest: { position: meTop } } };
    const live = new Map(Object.entries(members));
    const guild = {
        id: G,
        ownerId: OWNER,
        members: {
            me,
            fetch: async ({ user }) => {
                const m = live.get(String(user));
                if (!m) throw Object.assign(new Error('Unknown Member'), { code: 10007 });
                return m;
            }
        },
        calls
    };
    for (const [id, m] of live) {
        m.id = id;
        m.roles.remove = async (ids) => {
            calls.push(['remove', id, ids]);
            if (removeMode === 'throw') throw Object.assign(new Error('Missing Permissions'), { code: 50013 });
            if (removeMode === 'ok') for (const r of ids) m.roles.cache.delete(r);
            return m;
        };
        m.kick = async () => {
            calls.push(['kick', id]);
            if (removeMode === 'throw') throw Object.assign(new Error('Missing Permissions'), { code: 50013 });
            if (removeMode === 'ok') live.delete(id);
        };
    }
    return guild;
}
const role = (id, position, bits, managed = false) => [id, { id, position, managed, permissions: { bitfield: bits } }];
const rogueMember = (roles, bot = false) => ({ user: { id: ROGUE, bot }, kickable: true, roles: { cache: new Map(roles) } });
const strip = settings({ containment: { strip_dangerous_roles: true, remove_unauthorized_bots: true } });

test('containment is off by default and only runs for the right incidents', async () => {
    const guild = fakeGuild({ members: { [ROGUE]: rogueMember([role('700000000000000001', 5, PermissionFlagsBits.Administrator)]) } });
    assert.equal((await runContainment({ incident: criticalIncident, guild, settings: settings() })).status, 'not_enabled');
    assert.equal((await runContainment({ incident: { ...criticalIncident, rule: 'webhook_burst', severity: 'HIGH' }, guild, settings: strip })).status, 'not_applicable');
    assert.equal(guild.calls.length, 0);
});

test('containment removes only dangerous roles below ZiGBoT and verifies the result', async () => {
    const guild = fakeGuild({ members: { [ROGUE]: rogueMember([role('700000000000000001', 5, PermissionFlagsBits.Administrator), role('700000000000000002', 4, PermissionFlagsBits.SendMessages)]) } });
    const result = await runContainment({ incident: criticalIncident, guild, settings: strip });
    assert.equal(result.status, 'succeeded');
    assert.deepEqual(guild.calls, [['remove', ROGUE, ['700000000000000001']]], 'the harmless role is kept');
    assert.deepEqual(result.actions[0], { action: 'remove_roles', targetId: ROGUE, roleIds: ['700000000000000001'], result: 'ok' });
});

test('7. a failed or unverified action is never reported as success', async () => {
    const roles = [role('700000000000000001', 5, PermissionFlagsBits.Administrator)];
    const refused = await runContainment({ incident: criticalIncident, guild: fakeGuild({ removeMode: 'throw', members: { [ROGUE]: rogueMember(roles) } }), settings: strip });
    assert.equal(refused.status, 'failed');
    assert.match(refused.summary, /50013/);
    const ignored = await runContainment({ incident: criticalIncident, guild: fakeGuild({ removeMode: 'noop', members: { [ROGUE]: rogueMember(roles) } }), settings: strip });
    assert.equal(ignored.status, 'failed', 'Discord still shows the role');
    const alert = buildAlert({ incident: criticalIncident, guild: guildInfo, settings: strip, containment: refused });
    assert.match(alert.content, /Automatic containment was attempted but FAILED/);
    assert.doesNotMatch(alert.content, /\(verified\)/);
    const off = buildAlert({ incident: criticalIncident, guild: guildInfo, settings: settings(), containment: { status: 'not_enabled' } });
    assert.match(off.content, /Nothing was blocked or undone/);
});

test('8. role hierarchy, managed roles and missing permissions are respected', async () => {
    const above = fakeGuild({ meTop: 3, members: { [ROGUE]: rogueMember([role('700000000000000001', 5, PermissionFlagsBits.Administrator)]) } });
    const high = await runContainment({ incident: criticalIncident, guild: above, settings: strip });
    assert.equal(high.status, 'skipped');
    assert.equal(above.calls.length, 0);
    const managed = fakeGuild({ members: { [ROGUE]: rogueMember([role('700000000000000001', 2, PermissionFlagsBits.Administrator, true)]) } });
    assert.equal((await runContainment({ incident: criticalIncident, guild: managed, settings: strip })).status, 'skipped');
    const mixed = fakeGuild({ meTop: 4, members: { [ROGUE]: rogueMember([role('700000000000000001', 2, PermissionFlagsBits.BanMembers), role('700000000000000002', 6, PermissionFlagsBits.Administrator)]) } });
    const partial = await runContainment({ incident: criticalIncident, guild: mixed, settings: strip });
    assert.equal(partial.status, 'partial');
    assert.deepEqual(mixed.calls, [['remove', ROGUE, ['700000000000000001']]]);
    const noPerm = fakeGuild({ mePerms: [], members: { [ROGUE]: rogueMember([role('700000000000000001', 2, PermissionFlagsBits.Administrator)]) } });
    const denied = await runContainment({ incident: criticalIncident, guild: noPerm, settings: strip });
    assert.equal(denied.status, 'skipped');
    assert.match(denied.summary, /Manage Roles/);
    // Bot kick: never above ZiGBoT, never a non-bot.
    const botGuild = fakeGuild({ members: { [NEWBOT]: { user: { id: NEWBOT, bot: true }, kickable: false, roles: { cache: new Map() } } } });
    assert.equal((await runContainment({ incident: { rule: 'bot_added_admin', severity: 'HIGH', actorId: MOD, botId: NEWBOT }, guild: botGuild, settings: strip })).status, 'skipped');
    const kickGuild = fakeGuild({ members: { [NEWBOT]: { user: { id: NEWBOT, bot: true }, kickable: true, roles: { cache: new Map() } } } });
    const kicked = await runContainment({ incident: { rule: 'bot_added_admin', severity: 'HIGH', actorId: MOD, botId: NEWBOT }, guild: kickGuild, settings: strip });
    assert.equal(kicked.status, 'succeeded');
    assert.deepEqual(kickGuild.calls, [['kick', NEWBOT]], 'kicked, never banned');
});

test('9. the server owner and ZiGBoT itself are never targeted', async () => {
    const guild = fakeGuild({ members: { [OWNER]: rogueMember([role('700000000000000001', 2, PermissionFlagsBits.Administrator)]) } });
    const owner = await runContainment({ incident: { ...criticalIncident, actorId: OWNER }, guild, settings: strip });
    assert.equal(owner.status, 'skipped');
    assert.match(owner.summary, /server owner is never moderated/);
    const self = await runContainment({ incident: { ...criticalIncident, actorId: BOT }, guild, settings: strip });
    assert.equal(self.status, 'skipped');
    assert.equal(guild.calls.length, 0);
    const ownerBot = await runContainment({ incident: { rule: 'bot_added_admin', severity: 'HIGH', botId: OWNER }, guild, settings: strip });
    assert.equal(ownerBot.status, 'skipped');
});

// ---------- settings, storage, permissions ----------

function fakeSupabase(rows = {}) {
    const calls = [];
    const db = { zb_security_settings: rows.settings || [], zb_security_events: [], zb_security_status: [] };
    const guildStore = {
        enabled: true,
        request: async (p, { method = 'GET', body, prefer } = {}) => {
            calls.push({ path: p, method, body, prefer });
            const table = p.split('?')[0];
            if (method === 'GET') return db[table];
            if (method === 'POST' && table === 'zb_security_events') return body.map((row, i) => ({ id: db.zb_security_events.push(row) + i, ...row }));
            return null;
        }
    };
    return { guildStore, calls, db };
}

test('11. settings persist, survive a restart, and bad stored values fall back safely', async () => {
    const row = { guild_id: G, alert_channel_id: '600000000000000001', cooldown_minutes: 25, thresholds: { mass_delete: 7, window_seconds: 9999 }, containment: { strip_dangerous_roles: true, evil: true }, trusted_user_ids: [MOD, 'nope'] };
    const first = createAntiNukeStore({ guildStore: fakeSupabase({ settings: [row] }).guildStore });
    const loaded = await first.getSettings(G);
    assert.equal(loaded.alert_channel_id, '600000000000000001');
    assert.equal(loaded.thresholds.mass_delete, 7);
    assert.equal(loaded.thresholds.window_seconds, 60, 'out-of-range values fall back to the default');
    assert.deepEqual(loaded.containment, { strip_dangerous_roles: true, remove_unauthorized_bots: false });
    assert.deepEqual(loaded.trusted_user_ids, [MOD]);
    // "Restart": a fresh store reads the same row back.
    const restarted = createAntiNukeStore({ guildStore: fakeSupabase({ settings: [row] }).guildStore });
    assert.deepEqual(await restarted.getSettings(G), loaded);
    // Seeding never overwrites admin choices.
    const fake = fakeSupabase();
    await createAntiNukeStore({ guildStore: fake.guildStore }).ensureSettings(G);
    assert.match(fake.calls[0].prefer, /resolution=ignore-duplicates/);
    // A database outage never stops monitoring: defaults are used.
    const broken = createAntiNukeStore({ guildStore: { enabled: true, request: async () => { throw new Error('down'); } }, logger: { error() {} } });
    assert.deepEqual(await broken.getSettings(G), defaultAntiNukeSettings(G));
    // Legacy mode (no Supabase): defaults, nothing stored.
    const legacy = createAntiNukeStore({ guildStore: { enabled: false } });
    assert.equal(await legacy.recordIncident({ guild_id: G }), null);
});

test('dashboard validation: real ids only, sane thresholds, no switch that stops monitoring', () => {
    const channelIds = new Set(['600000000000000001']);
    const roleIds = new Set(['800000000000000001']);
    const ok = validateAntiNukeSettings({ alert_channel_id: '600000000000000001', staff_role_id: '800000000000000001', thresholds: { mass_delete: 6 }, trusted_user_ids: [MOD, MOD] }, { channelIds, roleIds, guildId: G });
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.value.trusted_user_ids, [MOD]);
    const bad = validateAntiNukeSettings({ alert_channel_id: '600000000000000099', thresholds: { mass_delete: 1, mod_burst: 9 }, trusted_user_ids: ['abc'], cooldown_minutes: 0, maintenance_until: new Date(Date.now() + 10 * 3_600_000).toISOString() }, { channelIds, roleIds, guildId: G });
    assert.equal(bad.ok, false);
    for (const field of ['alert_channel_id', 'thresholds.mass_delete', 'thresholds.mod_burst', 'trusted_user_ids', 'cooldown_minutes', 'maintenance_until']) assert.ok(bad.errors[field], field);
    const keys = Object.keys(ok.value).join(' ');
    assert.doesNotMatch(keys, /enabled|monitoring|disable/, 'no field can switch monitoring or alerts off');
});

test('13. missing permissions are reported exactly', () => {
    const P = PermissionFlagsBits;
    assert.deepEqual(missingPermissions(P.ViewChannel | P.SendMessages, settings()).map((p) => p.name), ['View Audit Log', 'Manage Channels']);
    assert.deepEqual(missingPermissions(P.ViewAuditLog | P.ViewChannel | P.SendMessages | P.ManageChannels, settings()).map((p) => p.name), []);
    assert.deepEqual(missingPermissions(P.ViewAuditLog | P.ViewChannel | P.SendMessages | P.ManageChannels, strip).map((p) => p.name), ['Manage Roles', 'Kick Members'], 'containment adds its own needs');
    assert.deepEqual(missingPermissions(P.Administrator, strip), []);
});

// ---------- monitor (end to end with fakes) ----------

function monitorGuild({ perms = [PermissionFlagsBits.ViewAuditLog, PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels], channels = [] } = {}) {
    const sent = [];
    const created = [];
    const bitfield = perms.reduce((a, b) => a | b, 0n);
    const me = { id: BOT, permissions: { bitfield, has: (bit) => perms.includes(bit) }, roles: { highest: { position: 10 } } };
    const cache = new Map(channels.map((c) => [c.id, c]));
    cache.find = (fn) => [...cache.values()].find(fn);
    const makeChannel = (id, name) => ({
        id, name, type: ChannelType.GuildText,
        isTextBased: () => true,
        permissionsFor: () => ({ has: () => perms.includes(PermissionFlagsBits.SendMessages) }),
        send: async (payload) => { sent.push({ channel: id, ...payload }); return { id: 'm' }; }
    });
    const guild = {
        id: G, name: 'Example', ownerId: OWNER,
        members: { me, fetch: async () => { throw new Error('no'); } },
        roles: { cache: new Map() },
        channels: {
            cache,
            create: async (options) => {
                created.push(options);
                const channel = makeChannel('600000000000000777', options.name);
                cache.set(channel.id, channel);
                return channel;
            }
        },
        fetchOwner: async () => ({ send: async (payload) => sent.push({ dm: true, ...payload }) })
    };
    return { guild, sent, created, makeChannel };
}

test('14. joining a server starts protection: settings, private alert channel, status', async () => {
    const fake = fakeSupabase();
    const store = createAntiNukeStore({ guildStore: fake.guildStore });
    const { guild, created, sent } = monitorGuild();
    const monitor = createAntiNuke({ client: { user: { id: BOT }, guilds: { cache: new Map() } }, store, logger: { log() {}, error() {} } });
    const status = await monitor.setupNewGuild(guild);
    assert.ok(fake.calls.some((c) => c.path.startsWith('zb_security_settings?on_conflict') && c.method === 'POST'), 'default settings row');
    assert.equal(created.length, 1);
    assert.equal(created[0].name, 'zigbot-security');
    assert.deepEqual(created[0].permissionOverwrites[0], { id: G, deny: [PermissionFlagsBits.ViewChannel] }, 'private: @everyone cannot see it');
    assert.ok(fake.calls.some((c) => c.method === 'PATCH' && c.path.includes('alert_channel_id=is.null')), 'never overwrites an admin choice');
    assert.match(sent[0].content, /Anti-Nuke is on/);
    assert.deepEqual(sent[0].allowedMentions, { parse: [] });
    assert.equal(status.monitoring, true);
    // Without View Audit Log the dashboard is told monitoring is NOT active.
    const blind = monitorGuild({ perms: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] });
    const blindStatus = await monitor.reportStatus(blind.guild);
    assert.equal(blindStatus.monitoring, false);
    assert.deepEqual(blindStatus.missing_permissions, ['View Audit Log', 'Manage Channels']);
    // Wiring in the live bot.
    const index = read('src/index.js');
    assert.match(index, /GatewayIntentBits\.GuildModeration/);
    assert.match(index, /client\.on\(Events\.GuildAuditLogEntryCreate, \(entry, guild\) => \{\n\s+antiNuke\.onAuditLogEntry\(entry, guild\);/);
    assert.match(index, /client\.on\(Events\.GuildMemberAdd, \(member\) => \{\n\s+antiNuke\.onMemberAdd\(member\);/);
    assert.match(index, /await antiNuke\.setupNewGuild\(guild\)/);
    assert.match(index, /antiNuke\.start\(\);/);
    assert.match(read('dashboard/lib/discord.js'), /const INVITE_PERMISSIONS = \[10n, 11n, 14n, 16n, 6n, 20n, 21n, 13n, 1n, 2n, 4n, 28n, 40n, 7n\]/, 'the invite asks for View Audit Log');
});

test('an incident is recorded, alerted, and falls back to an owner DM when no channel works', async () => {
    const fake = fakeSupabase();
    const store = createAntiNukeStore({ guildStore: fake.guildStore });
    const alerting = monitorGuild({ channels: [] });
    const channel = alerting.makeChannel('600000000000000001', 'security');
    alerting.guild.channels.cache.set(channel.id, channel);
    fake.db.zb_security_settings = [{ guild_id: G, alert_channel_id: channel.id }];
    const monitor = createAntiNuke({ client: { user: { id: BOT }, guilds: { cache: new Map() } }, store, logger: { log() {}, error() {} }, dashboardUrl: (id) => `https://zigbotai.vercel.app/dashboard/${id}` });
    for (let i = 0; i < 4; i += 1) await monitor.processAuditEntry(entry(AuditLogEvent.ChannelDelete, ROGUE), alerting.guild);
    assert.equal(fake.db.zb_security_events.length, 1);
    assert.equal(fake.db.zb_security_events[0].rule, 'mass_delete');
    assert.equal(fake.db.zb_security_events[0].containment_status, 'not_enabled');
    assert.equal(alerting.sent.length, 1);
    assert.match(alerting.sent[0].content, /dashboard\/900000000000000001/);
    assert.ok(fake.calls.some((c) => c.method === 'PATCH' && c.body?.alert_status === 'sent'));
    // No usable channel: the owner gets a DM instead.
    const dmFake = fakeSupabase();
    const dmGuild = monitorGuild({ perms: [PermissionFlagsBits.ViewAuditLog] });
    const dmMonitor = createAntiNuke({ client: { user: { id: BOT }, guilds: { cache: new Map() } }, store: createAntiNukeStore({ guildStore: dmFake.guildStore }), logger: { log() {}, error() {} } });
    for (let i = 0; i < 4; i += 1) await dmMonitor.processAuditEntry(entry(AuditLogEvent.ChannelDelete, ROGUE), dmGuild.guild);
    assert.equal(dmGuild.sent[0].dm, true);
    assert.deepEqual(dmGuild.sent[0].allowedMentions, { parse: [] });
});

test('16. a huge burst stays bounded: queue limit, alert cap, no crash', async () => {
    const fake = fakeSupabase();
    const store = createAntiNukeStore({ guildStore: fake.guildStore });
    const { guild, sent, makeChannel } = monitorGuild();
    const channel = makeChannel('600000000000000001', 'zigbot-security');
    guild.channels.cache.set(channel.id, channel);
    const monitor = createAntiNuke({ client: { user: { id: BOT }, guilds: { cache: new Map() } }, store, logger: { log() {}, error() {} }, queueMax: 100 });
    // 300 different attackers deleting 4 channels each, all at once.
    const pending = [];
    for (let a = 0; a < 300; a += 1) {
        const actor = `200000000000000${String(a).padStart(3, '0')}`; // string: past Number's safe range
        for (let i = 0; i < 4; i += 1) pending.push(monitor.onAuditLogEntry(entry(AuditLogEvent.ChannelDelete, actor), guild));
    }
    await Promise.all(pending.filter(Boolean));
    assert.ok(monitor.dropped > 0, 'events past the queue bound are dropped, not buffered forever');
    assert.ok(pending.filter((p) => p === false).length === monitor.dropped);
    assert.ok(sent.length <= ALERTS_PER_WINDOW, `at most ${ALERTS_PER_WINDOW} alerts per window, got ${sent.length}`);
    // Incidents past the alert cap are still recorded, marked "held" instead of posted.
    assert.ok(fake.db.zb_security_events.length > sent.length);
    assert.ok(fake.calls.some((c) => c.method === 'PATCH' && c.body?.alert_status === 'held'));
    // The engine's memory stays bounded too.
    const { engine } = engineAt();
    for (let i = 0; i < 5000; i += 1) engine.process(normalizeAuditEntry(entry(AuditLogEvent.WebhookUpdate, ROGUE)), settings(), ctx());
    assert.ok(engine._guilds.get(G).actors.get(ROGUE).events.length <= 200);
});

// ---------- authorization, isolation, free ----------

test('12. one server can never read or change another server\'s security data', async () => {
    const settingsRoute = read('dashboard/app/api/guilds/[guildId]/antinuke/route.js');
    const eventsRoute = read('dashboard/app/api/guilds/[guildId]/antinuke/events/route.js');
    const eventRoute = read('dashboard/app/api/guilds/[guildId]/antinuke/events/[eventId]/route.js');
    for (const route of [settingsRoute, eventsRoute, eventRoute]) {
        assert.match(route, /await requireGuildAdmin\(guildId\)/, 'live admin check on every route');
    }
    assert.match(settingsRoute, /eq\('guild_id', guildId\)/);
    assert.match(eventsRoute, /\.from\('zb_security_events'\)\.select\(COLUMNS\)\.eq\('guild_id', String\(guild\.id\)\)/);
    assert.match(eventRoute, /\.eq\('id', Number\(eventId\)\)\n\s+\.eq\('guild_id', String\(guild\.id\)\)/, 'an incident update needs both ids');
    // Browsers get no direct table access (RLS + no grants), checked in real Postgres.
    const { PGlite } = await import('@electric-sql/pglite');
    const db = new PGlite();
    await db.exec(`
        create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
        create schema auth; create table auth.users (id uuid primary key);
        create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
        create schema storage; create table storage.buckets (id text primary key, name text not null, public boolean default false, file_size_limit bigint, allowed_mime_types text[]);
        grant usage on schema public to anon, authenticated, service_role;
        alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    `);
    const migrations = fs.readdirSync(path.join(ROOT, 'supabase', 'migrations')).filter((n) => n.endsWith('.sql')).sort()
        .map((n) => fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', n), 'utf8')).join('\n');
    await db.exec(migrations);
    await db.exec(migrations); // re-runnable
    await db.exec('set role service_role');
    await db.query("insert into public.zb_security_events (guild_id, rule, severity) values ($1, 'mass_delete', 'CRITICAL'), ($2, 'join_burst', 'HIGH')", [G, G2]);
    await assert.rejects(() => db.query("insert into public.zb_security_events (guild_id, rule, severity) values ($1, 'x', 'LOW')", [G]), /check constraint/);
    await assert.rejects(() => db.query("insert into public.zb_security_events (guild_id, rule, severity, alert_status) values ($1, 'x', 'HIGH', 'shouted')", [G]), /check constraint/);
    for (const role of ['authenticated', 'anon']) {
        await db.exec(`reset role; set role ${role}`);
        for (const table of ['zb_security_events', 'zb_security_settings', 'zb_security_status']) {
            await assert.rejects(() => db.query(`select * from public.${table}`), /permission denied/, `${role} cannot read ${table}`);
        }
    }
    await db.close();
});

test('15. core protection is free: no plan or Premium checks anywhere in Anti-Nuke', () => {
    const files = [
        'src/antinuke/engine.js', 'src/antinuke/alerts.js', 'src/antinuke/containment.js', 'src/antinuke/store.js', 'src/antinuke/monitor.js',
        'dashboard/lib/shared/antinuke.js', 'dashboard/app/api/guilds/[guildId]/antinuke/route.js',
        'dashboard/app/api/guilds/[guildId]/antinuke/events/route.js', 'dashboard/app/api/guilds/[guildId]/antinuke/events/[eventId]/route.js',
        'dashboard/components/AntiNukeTab.js'
    ];
    for (const file of files) {
        const code = read(file).split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
        assert.doesNotMatch(code, /loadPlan|isPremiumActive|\.premium\b|premium:|PREMIUM/, `${file} must not gate on a plan`);
    }
    const landing = require('../dashboard/lib/landing');
    const row = landing.premiumComparison().find((r) => r.id === 'antinuke');
    assert.deepEqual([row.free, row.premium], [true, true]);
    assert.equal(landing.features.find((f) => f.id === 'antinuke').badge, undefined, 'no Premium badge');
});
