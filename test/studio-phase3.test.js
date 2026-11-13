// ZiGBoT Studio Phase 3: customization, token validation, encrypted secrets.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const secrets = require('../dashboard/lib/studio/secrets');
const { checkBotToken } = require('../dashboard/lib/studio/discordToken');
const customize = require('../dashboard/lib/studio/customize');
const { generateProject } = require('../dashboard/lib/studio/generators');

const ROOT = path.join(__dirname, '..');
const KEY = crypto.randomBytes(32).toString('base64');
// Shaped like a real bot token, but made up.
const TOKEN = `${'MTA'.padEnd(26, 'x')}.Gh1jK2.${'a'.repeat(38)}`;

test('AES-256-GCM: round trip, random IV, last 4 only in clear', () => {
    const aad = secrets.aadFor('p1', 'DISCORD_TOKEN');
    const a = secrets.encryptSecret(TOKEN, { key: KEY, aad });
    const b = secrets.encryptSecret(TOKEN, { key: KEY, aad });
    assert.notEqual(a.ciphertext, b.ciphertext, 'a fresh IV each time');
    assert.equal(a.last4, TOKEN.slice(-4));
    assert.doesNotMatch(JSON.stringify(a), new RegExp(TOKEN.slice(0, 20)));
    assert.equal(secrets.decryptSecret(a, { key: KEY, aad }), TOKEN);
    assert.equal(secrets.decryptSecret(a, { key: Buffer.from(KEY, 'base64').toString('hex'), aad }), TOKEN, 'hex keys work too');
});

test('AES-256-GCM: tampering, another key or another project/name all fail without revealing anything', () => {
    const aad = secrets.aadFor('p1', 'DISCORD_TOKEN');
    const sealed = secrets.encryptSecret(TOKEN, { key: KEY, aad });
    const flip = (b64) => { const buf = Buffer.from(b64, 'base64'); buf[0] ^= 1; return buf.toString('base64'); };
    for (const [row, opts] of [
        [{ ...sealed, ciphertext: flip(sealed.ciphertext) }, { key: KEY, aad }],
        [{ ...sealed, tag: flip(sealed.tag) }, { key: KEY, aad }],
        [sealed, { key: crypto.randomBytes(32).toString('base64'), aad }],
        [sealed, { key: KEY, aad: secrets.aadFor('p2', 'DISCORD_TOKEN') }],
        [sealed, { key: KEY, aad: secrets.aadFor('p1', 'OTHER') }]
    ]) {
        assert.throws(() => secrets.decryptSecret(row, opts), (e) => e.message === 'Secret could not be decrypted.');
    }
    assert.throws(() => secrets.encryptSecret(TOKEN, { key: 'short', aad }), /32 bytes/);
    assert.throws(() => secrets.encryptSecret(TOKEN, { key: '', aad }), /32 bytes/);
    assert.throws(() => secrets.encryptSecret('', { key: KEY, aad }), /Nothing/);
});

test('status and redaction never expose a secret', () => {
    assert.deepEqual(secrets.secretStatus(null), { configured: false });
    const status = secrets.secretStatus({ last4: 'abcd', ciphertext: 'zzz', iv: 'x', tag: 'y', updated_at: 't', meta: { botUsername: 'Helper' } });
    assert.deepEqual(Object.keys(status).sort(), ['configured', 'last4', 'meta', 'updatedAt']);
    assert.equal(secrets.redact(`login failed for ${TOKEN}`), 'login failed for [redacted token]');
});

test('token check: one GET /users/@me with the bot token, nothing else; result never contains the token', async () => {
    const calls = [];
    const ok = await checkBotToken(TOKEN, { fetchImpl: async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, json: async () => ({ id: '123456789012345678', username: 'Helper', bot: true }) }; } });
    assert.deepEqual(ok, { ok: true, bot: { id: '123456789012345678', username: 'Helper' } });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://discord.com/api/v10/users/@me');
    assert.equal(calls[0].init.method, undefined, 'a GET');
    assert.equal(calls[0].init.headers.Authorization, `Bot ${TOKEN}`);
    assert.doesNotMatch(JSON.stringify(ok), /Gh1jK2/);
});

test('token check: bad format, revoked token, user token, rate limit and network errors are refused plainly', async () => {
    const reply = (status, body) => async () => ({ ok: status === 200, status, json: async () => body });
    let called = false;
    assert.match((await checkBotToken('not-a-token', { fetchImpl: async () => { called = true; } })).reason, /does not look like/);
    assert.equal(called, false, 'malformed tokens never reach Discord');
    assert.match((await checkBotToken(TOKEN, { fetchImpl: reply(401, {}) })).reason, /not valid/);
    assert.match((await checkBotToken(TOKEN, { fetchImpl: reply(200, { id: '1', bot: false }) })).reason, /user account/);
    const limited = await checkBotToken(TOKEN, { fetchImpl: reply(429, {}) });
    assert.equal(limited.retry, true);
    const down = await checkBotToken(TOKEN, { fetchImpl: async () => { throw new Error(`connect failed ${TOKEN}`); } });
    assert.match(down.reason, /Could not reach Discord/);
    assert.doesNotMatch(down.reason, /Gh1jK2/, 'errors never echo the token');
});

test('settings: presence, colour, timezone, messages and commands validated; Developer Portal settings listed', () => {
    const ok = customize.validateSettings({ embedColor: '#ff00aa', presence: { status: 'dnd', activityType: 'Watching', activityText: '  the server ' }, timezone: 'Asia/Kolkata', messages: { welcome: 'Hi {user}!' }, disabledCommands: ['kick'] }, 'moderation');
    assert.deepEqual(ok.value.presence, { status: 'dnd', activityType: 'Watching', activityText: 'the server' });
    assert.equal(ok.value.embedColor, '#FF00AA');
    assert.equal(ok.value.messages.goodbye, '{user} left {server}.', 'defaults fill the gaps');
    const errors = (input, template = 'moderation') => Object.keys(customize.validateSettings(input, template).errors || {});
    assert.deepEqual(errors({ embedColor: 'red' }), ['embedColor']);
    assert.deepEqual(errors({ presence: { status: 'away' } }), ['presence.status']);
    assert.deepEqual(errors({ timezone: 'Mars/Olympus' }), ['timezone']);
    assert.deepEqual(errors({ messages: { welcome: 'Hi @everyone' } }), ['messages.welcome']);
    assert.deepEqual(errors({ messages: { error: '' } }), ['messages.error']);
    assert.deepEqual(errors({ disabledCommands: ['ask'] }), ['disabledCommands'], 'not a command of this template');
    assert.deepEqual(errors({ disabledCommands: ['ping'] }, 'blank'), ['disabledCommands'], 'at least one command stays on');
    assert.deepEqual(errors({ token: 'x' }), ['_'], 'unknown keys refused');
    assert.ok(customize.PORTAL_ONLY.some((p) => /username/i.test(p.what)) && customize.PORTAL_ONLY.some((p) => /intents/i.test(p.what)));
});

test('live preview follows the same placeholders as the generated bot', () => {
    const view = customize.preview({ presence: { status: 'idle', activityType: 'Listening', activityText: 'lofi' }, messages: { welcome: 'Hey {user}, welcome to {server}' } }, { botName: 'Helper' });
    assert.deepEqual([view.statusLabel, view.activityLine, view.welcome], ['Idle', 'Listening to lofi', 'Hey @NewMember, welcome to My Server']);
});

test('saved settings change only settings.json of the generated project', () => {
    const { value } = customize.validateSettings({ embedColor: '#123456', disabledCommands: ['poll'] }, 'community');
    const base = generateProject({ name: 'Bot', botName: 'Helper', framework: 'discordpy', template: 'community' });
    const after = generateProject({ name: 'Bot', botName: 'Helper', framework: 'discordpy', template: 'community', settings: value });
    assert.deepEqual(after.filter((f, i) => f.content !== base[i].content).map((f) => f.path), ['settings.json']);
});

test('routes: the token is never returned, the service role is used only after the owner check', () => {
    const src = fs.readFileSync(path.join(ROOT, 'dashboard', 'app', 'api', 'studio', 'projects', '[projectId]', 'token', 'route.js'), 'utf8');
    for (const verb of ['GET', 'POST', 'DELETE']) {
        const body = src.slice(src.indexOf(`export const ${verb}`));
        assert.ok(body.indexOf('getOwnedProject(') < body.indexOf('createServiceClient()') || !/createServiceClient\(\)/.test(body.split('export const')[1]), verb);
    }
    assert.doesNotMatch(src, /json\(\{[^}]*\btoken: token\b/, 'never json({ token: token })');
    assert.doesNotMatch(src, /console\.(log|error)\([^)]*token/i, 'the token is never logged');
    assert.doesNotMatch(src, /\.select\([^)]*ciphertext/, 'ciphertext is never read back by the API');
    assert.match(src, /secrets\.encryptSecret\(token, \{ key: process\.env\.STUDIO_SECRETS_KEY/);
    const exportRoute = fs.readFileSync(path.join(ROOT, 'dashboard', 'app', 'api', 'studio', 'projects', '[projectId]', 'export', 'route.js'), 'utf8');
    assert.doesNotMatch(exportRoute, /studio_secrets/, 'exports never read secrets');
    assert.match(fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8'), /^STUDIO_SECRETS_KEY=$/m);
});
