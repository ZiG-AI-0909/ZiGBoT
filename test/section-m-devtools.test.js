// Section M: health endpoints, maintenance mode, emergency shutdown, config export/import.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const shared = require('../dashboard/lib/shared');
const { buildExport, parseImport } = require('../dashboard/lib/shared/configPorting');
const { startHealthServer } = require('../src/health');
const { MemoryFeatureStore } = require('../src/features/store');
const { createOps } = require('../src/features/ops');
const { YOUTUBE_COMMANDS, buildDefinitions } = require('../src/slash');

const OWNER = '100000000000000001';
const ADMIN = '100000000000000002';
const G = '900000000000000001';

const get = (port, urlPath) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: urlPath }, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body }));
    }).on('error', reject);
});

test('bot health: "/" is unchanged; /healthz reports readiness as JSON (200 ready, 503 not)', async () => {
    let ready = true;
    const server = startHealthServer(0, { getStatus: () => ({ ok: ready, discord: { ready, guilds: 6 }, maintenance: false }) });
    await new Promise((r) => server.once('listening', r));
    const { port } = server.address();
    try {
        const root = await get(port, '/');
        assert.deepEqual([root.status, root.body], [200, 'ZiGBoT is alive']);
        const ok = await get(port, '/healthz');
        assert.equal(ok.status, 200);
        assert.match(ok.type, /application\/json/);
        assert.deepEqual(JSON.parse(ok.body), { ok: true, discord: { ready: true, guilds: 6 }, maintenance: false });
        ready = false;
        assert.equal((await get(port, '/healthz')).status, 503);
    } finally {
        server.close();
    }
    const plain = startHealthServer(0);
    await new Promise((r) => plain.once('listening', r));
    try {
        assert.equal((await get(plain.address().port, '/healthz')).body, 'ZiGBoT is alive', 'without a status source it stays the plain liveness probe');
    } finally {
        plain.close();
    }
});

test('the status report the bot exposes holds no ids, tokens or settings', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');
    const fn = src.slice(src.indexOf('function botStatus()'), src.indexOf('startHealthServer(undefined'));
    assert.doesNotMatch(fn, /token|secret|key|guildId|\.id\b/i);
    assert.match(src, /startHealthServer\(undefined, \{ getStatus: botStatus \}\)/);
});

function opsFixture() {
    let t = 1_000_000;
    const audits = [];
    const shutdowns = [];
    const store = new MemoryFeatureStore({ now: () => t });
    const make = () => createOps({ store, ownerId: OWNER, now: () => t, logger: { error() {} },
        auditLog: async (e) => audits.push(e), onShutdown: async () => shutdowns.push(t),
        getStatus: () => ({ ok: true, discord: { ready: true, guilds: 3, ping: 40 }, database: { mongo: true, supabase: true }, ai: { providers: ['groq'] }, workers: { scheduler: { running: true, lastTickAt: t, failed: 0 } }, uptimeSeconds: 600 }) });
    const interaction = (userId, { sub = null, state = null, customId = null } = {}) => {
        const replies = [];
        return { replies, user: { id: userId }, commandName: 'owner', customId, guild: { id: G },
            options: { getSubcommand: () => sub, getString: () => state },
            isRepliable: () => true, reply: async (p) => replies.push(p) };
    };
    return { make, store, audits, shutdowns, interaction, advance: (ms) => { t += ms; } };
}
const buttonId = (i, label) => i.replies[0].components[0].components.find((b) => b.label === label).custom_id;

test('/owner: bot owner only, status works, everyone else is refused and audited', async () => {
    const f = opsFixture();
    const ops = f.make();
    const denied = f.interaction(ADMIN, { sub: 'status' });
    await ops.handleSlash(denied);
    assert.match(denied.replies[0].content, /Only the bot owner/);
    assert.ok(f.audits.some((a) => a.action === 'owner_status' && a.result === 'DENIED'));
    const status = f.interaction(OWNER, { sub: 'status' });
    await ops.handleSlash(status);
    assert.match(status.replies[0].content, /Discord: ✅ · 3 servers · ping 40 ms[\s\S]*AI providers: groq/);
    assert.equal(createOps({ store: f.store, ownerId: '' }).handlesSlash({ commandName: 'owner' }), true);
});

test('maintenance mode: needs confirmation, only the owner can confirm, gates members but not the owner, survives a restart', async () => {
    const f = opsFixture();
    const ops = f.make();
    const ask = f.interaction(OWNER, { sub: 'maintenance', state: 'on' });
    await ops.handleSlash(ask);
    assert.equal(ops.isMaintenance(), false, 'nothing changes before confirmation');
    const intruder = f.interaction(ADMIN, { customId: buttonId(ask, 'Confirm') });
    await ops.handleComponent(intruder);
    assert.match(intruder.replies[0].content, /Only the bot owner/);
    await ops.handleComponent(f.interaction(OWNER, { customId: buttonId(ask, 'Confirm') }));
    assert.equal(ops.isMaintenance(), true);
    const reuse = f.interaction(OWNER, { customId: buttonId(ask, 'Confirm') });
    await ops.handleComponent(reuse);
    assert.match(reuse.replies[0].content, /expired/, 'a confirmation works once');

    assert.equal(ops.blocksMessage({ author: { id: ADMIN } }), true);
    assert.equal(ops.blocksMessage({ author: { id: OWNER } }), false);
    const member = f.interaction(ADMIN);
    assert.equal(await ops.gateInteraction(member), true);
    assert.match(member.replies[0].content, /under maintenance/);
    assert.equal(await ops.gateInteraction(f.interaction(OWNER)), false);

    const restarted = f.make();
    assert.equal(restarted.isMaintenance(), false);
    await restarted.load();
    assert.equal(restarted.isMaintenance(), true, 'saved state is restored');
    const off = f.interaction(OWNER, { sub: 'maintenance', state: 'off' });
    await restarted.handleSlash(off);
    assert.equal(restarted.isMaintenance(), false);
    assert.ok(f.audits.some((a) => a.action === 'maintenance_on') && f.audits.some((a) => a.action === 'maintenance_off'));
});

test('emergency shutdown: confirmation expires after 60 s, cancel does nothing, confirm closes the connection', async () => {
    const f = opsFixture();
    const ops = f.make();
    const first = f.interaction(OWNER, { sub: 'shutdown' });
    await ops.handleSlash(first);
    f.advance(61_000);
    const late = f.interaction(OWNER, { customId: buttonId(first, 'Confirm') });
    await ops.handleComponent(late);
    assert.match(late.replies[0].content, /expired/);
    const second = f.interaction(OWNER, { sub: 'shutdown' });
    await ops.handleSlash(second);
    const cancel = f.interaction(OWNER, { customId: buttonId(second, 'Cancel') });
    await ops.handleComponent(cancel);
    assert.match(cancel.replies[0].content, /Cancelled/);
    assert.deepEqual(f.shutdowns, []);
    const third = f.interaction(OWNER, { sub: 'shutdown' });
    await ops.handleSlash(third);
    await ops.handleComponent(f.interaction(OWNER, { customId: buttonId(third, 'Confirm') }));
    assert.equal(f.shutdowns.length, 1);
    assert.equal(ops.isMaintenance(), true, 'stays in maintenance after a restart until turned off');
    assert.ok(f.audits.some((a) => a.action === 'emergency_shutdown'));
});

test('/owner is registered in home servers only and is not in the public catalog', () => {
    assert.ok(YOUTUBE_COMMANDS.has('owner'));
    assert.ok(buildDefinitions().some((d) => d.name === 'owner'));
    const catalog = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'dashboard', 'data', 'commands.json'), 'utf8'));
    assert.ok(!catalog.categories.flatMap((c) => c.commands).some((c) => c.name === 'owner'));
});

test('src/index.js gates messages and interactions on maintenance inside the existing listeners', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');
    const messages = src.slice(src.indexOf('client.on(Events.MessageCreate,'));
    assert.ok(messages.indexOf('features.blocksMessage(message)') < messages.indexOf('guildRuntime(message.guild'));
    const interactions = src.slice(src.indexOf('client.on(Events.InteractionCreate,'));
    assert.ok(interactions.indexOf('features.gateInteraction(interaction)') < interactions.indexOf('features.isComponent(interaction)'));
});

// ------------------------------------------------------- config export/import
test('config export: every editor setting, no row ids, versions or timestamps; import round-trips and validates', () => {
    const config = { ...shared.defaultGuildConfig({ guildId: G }), response_instructions: 'Be kind', version: 7, updated_at: 'x', guild_id: G };
    const exported = buildExport(config, { guildId: G, guildName: 'Chill Zone', now: () => Date.UTC(2026, 10, 13) });
    assert.equal(exported.format, 'zigbot-config');
    assert.equal(exported.exportedAt, '2026-11-13T00:00:00.000Z');
    for (const key of ['version', 'updated_at', 'guild_id']) assert.equal(exported.settings[key], undefined, key);
    assert.equal(exported.settings.response_instructions, 'Be kind');
    assert.ok(exported.settings.feature_settings, 'optional feature settings are included');

    const back = parseImport(JSON.stringify({ ...exported, settings: { ...exported.settings, version: 99, evil_column: 'drop table', guild_id: '900000000000000002' } }));
    assert.equal(back.config.version, undefined);
    assert.equal(back.config.guild_id, undefined, 'an import can never retarget another server');
    assert.equal(back.config.evil_column, undefined, 'unknown keys are dropped');
    const valid = shared.validateGuildConfig(back.config, { channelIds: new Set(), roleIds: new Set(), guildId: G });
    assert.equal(valid.ok, true, JSON.stringify(valid.errors));
});

test('config import refuses anything that is not a ZiGBoT export', () => {
    for (const [input, pattern] of [['', /empty/], ['{', /not valid JSON/], ['[]', /not a ZiGBoT/], [JSON.stringify({ format: 'zigbot-config', version: 2, settings: {} }), /version 2/], [JSON.stringify({ format: 'zigbot-config', version: 1 }), /no settings/], ['x'.repeat(210 * 1024), /200 KB/]]) {
        assert.match(parseImport(input).error, pattern, input.slice(0, 30));
    }
    // An exported channel id that does not exist in the target server is rejected by the normal validator.
    const { config } = parseImport(JSON.stringify(buildExport({ ...shared.defaultGuildConfig({ guildId: G }), log_channel_id: '300000000000000099' }, { guildId: G })));
    const result = shared.validateGuildConfig(config, { channelIds: new Set(['300000000000000001']), roleIds: new Set(), guildId: G });
    assert.equal(result.ok, false);
});

test('export and import routes are owner-only and reuse the normal save validation', () => {
    const root = path.join(__dirname, '..', 'dashboard', 'app', 'api', 'guilds', '[guildId]', 'config');
    const exp = fs.readFileSync(path.join(root, 'export', 'route.js'), 'utf8');
    const imp = fs.readFileSync(path.join(root, 'import', 'route.js'), 'utf8');
    for (const src of [exp, imp]) {
        assert.match(src, /await requireGuildAdmin\(guildId\)/);
        assert.match(src, /if \(!decision\?\.isOwner\) throw new HttpError\(403/);
    }
    assert.match(imp, /validateGuildConfig\(parsed\.config, \{ channelIds, channelTypes, roleIds, guildId: String\(guild\.id\) \}\)/);
    assert.match(imp, /configPremiumErrors/);
    assert.match(imp, /\.eq\('guild_id', String\(guild\.id\)\)/);
    const health = fs.readFileSync(path.join(__dirname, '..', 'dashboard', 'app', 'api', 'health', 'route.js'), 'utf8');
    assert.match(health, /searchParams\.get\('deep'\) === '1'/);
});
