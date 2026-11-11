const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { verifyDiscordSignature, parseWebhookEvent, describeEvent } = require('../dashboard/lib/shared/discordWebhook');

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const PUBLIC_HEX = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
const NOW = 1_800_000_000_000;
const TS = String(NOW / 1000);
const sign = (ts, body) => crypto.sign(null, Buffer.from(ts + body), privateKey).toString('hex');

const USER = { id: '900000000000000001', username: 'zig', global_name: 'ZiG' };
const GUILD = { id: '900000000000000002', name: 'Chill Zone' };
const event = (type, data) => ({ version: 1, application_id: '900000000000000003', type: 1, event: { type, timestamp: '2026-11-10T08:00:00.000Z', data } });

test('Discord signature: accepts our key, refuses tampering, other keys and replays', () => {
    const body = JSON.stringify({ type: 0 });
    const signature = sign(TS, body);
    assert.equal(verifyDiscordSignature(body, signature, TS, PUBLIC_HEX, { now: NOW }), true);
    assert.equal(verifyDiscordSignature(`${body} `, signature, TS, PUBLIC_HEX, { now: NOW }), false, 'body changed');
    assert.equal(verifyDiscordSignature(body, signature, String(Number(TS) + 1), PUBLIC_HEX, { now: NOW }), false, 'timestamp changed');
    const other = crypto.generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
    assert.equal(verifyDiscordSignature(body, signature, TS, other, { now: NOW }), false, 'another app');
    assert.equal(verifyDiscordSignature(body, signature, TS, PUBLIC_HEX, { now: NOW + 10 * 60 * 1000 }), false, 'replayed 10 minutes later');
    for (const bad of [null, '', 'zz', signature.slice(2)]) assert.equal(verifyDiscordSignature(body, bad, TS, PUBLIC_HEX, { now: NOW }), false);
    assert.equal(verifyDiscordSignature(body, signature, TS, '', { now: NOW }), false, 'no key configured');
});

test('install events become log rows; everything else is ignored', () => {
    const added = parseWebhookEvent(event('APPLICATION_AUTHORIZED', { integration_type: 0, user: USER, scopes: ['bot', 'applications.commands'], guild: GUILD }));
    assert.deepEqual(added, {
        event_type: 'APPLICATION_AUTHORIZED', integration_type: 0, user_discord_id: USER.id, user_name: 'ZiG',
        guild_id: GUILD.id, guild_name: 'Chill Zone', scopes: ['bot', 'applications.commands'], occurred_at: '2026-11-10T08:00:00.000Z'
    });
    const removed = parseWebhookEvent(event('APPLICATION_DEAUTHORIZED', { user: { id: 'not-an-id', username: 'x' } }));
    assert.equal(removed.user_discord_id, null);
    assert.equal(removed.guild_id, null);
    assert.equal(parseWebhookEvent({ type: 0 }), null, 'PING');
    assert.equal(parseWebhookEvent(event('ENTITLEMENT_CREATE', {})), null);
    assert.equal(parseWebhookEvent(null), null);
});

test('creator DM text: who and where, never a mention', () => {
    const added = parseWebhookEvent(event('APPLICATION_AUTHORIZED', { integration_type: 0, user: USER, guild: { ...GUILD, name: '@everyone party' } }));
    assert.match(describeEvent(added), /ZiG.*added ZiGBoT to \*\*@everyone party\*\*/);
    assert.match(describeEvent({ ...added, integration_type: 1 }), /to their Discord account/);
    assert.match(describeEvent({ event_type: 'GUILD_REMOVED', guild_id: GUILD.id, guild_name: null }), /removed from `900000000000000002`/);
    assert.equal(describeEvent({ event_type: 'OTHER' }), null);
});

// ZIGBOT-010 regression: Discord retries a delivery it thinks failed. The
// same event must be stored (and DM'd about) once, not once per retry.
const { webhookDedupeKey, recordWebhookEvent } = require('../dashboard/lib/shared/discordWebhook');

test('dedupe key: same event gives the same key; any detail change gives another', () => {
    const body = event('APPLICATION_AUTHORIZED', { integration_type: 0, user: USER, guild: GUILD });
    const key = webhookDedupeKey(body);
    assert.match(key, /^[a-f0-9]{64}$/);
    assert.equal(webhookDedupeKey(JSON.parse(JSON.stringify(body))), key, 'a retried copy');
    const other = (patch) => webhookDedupeKey({ ...body, event: { ...body.event, ...patch } });
    assert.notEqual(other({ timestamp: '2026-11-10T08:00:01.000Z' }), key);
    assert.notEqual(other({ type: 'APPLICATION_DEAUTHORIZED' }), key);
    assert.notEqual(other({ data: { ...body.event.data, guild: { id: '900000000000000009' } } }), key);
    assert.notEqual(other({ data: { ...body.event.data, user: { id: '900000000000000008' } } }), key);
    assert.equal(other({ timestamp: 'not a date' }), null, 'no reliable timestamp: no key, never a false duplicate');
    assert.equal(webhookDedupeKey(null), null);
});

// A tiny stand-in for the Supabase query builder used by recordWebhookEvent.
function fakeDb({ upsertResult, insertResult = { error: null } }) {
    const calls = [];
    return {
        calls,
        from: (table) => ({
            upsert: (row, options) => ({ select: async (cols) => { calls.push(['upsert', table, row, options, cols]); return upsertResult; } }),
            insert: async (row) => { calls.push(['insert', table, row]); return insertResult; }
        })
    };
}
const BODY = event('APPLICATION_AUTHORIZED', { integration_type: 0, user: USER, guild: GUILD });
const ROW = parseWebhookEvent(BODY);

test('recordWebhookEvent: first delivery is stored with its key', async () => {
    const db = fakeDb({ upsertResult: { data: [{ id: 1 }], error: null } });
    assert.deepEqual(await recordWebhookEvent(db, ROW, BODY), { inserted: true });
    const [, table, row, options] = db.calls[0];
    assert.equal(table, 'zb_app_events');
    assert.equal(row.dedupe_key, webhookDedupeKey(BODY));
    assert.deepEqual(options, { onConflict: 'dedupe_key', ignoreDuplicates: true });
});

test('recordWebhookEvent: a retried delivery is recognised as a duplicate', async () => {
    const db = fakeDb({ upsertResult: { data: [], error: null } });
    assert.deepEqual(await recordWebhookEvent(db, ROW, BODY), { inserted: false });
});

test('recordWebhookEvent: before the migration runs it still stores the event', async () => {
    for (const code of ['42703', 'PGRST204', '42P10']) {
        const db = fakeDb({ upsertResult: { data: null, error: { code, message: 'no dedupe_key' } } });
        assert.deepEqual(await recordWebhookEvent(db, ROW, BODY), { inserted: true }, code);
        assert.equal(db.calls[1][0], 'insert');
        assert.equal('dedupe_key' in db.calls[1][2], false, 'fallback insert must not send the new column');
    }
});

test('recordWebhookEvent: other database errors are thrown (Discord retries later)', async () => {
    const db = fakeDb({ upsertResult: { data: null, error: { code: '08006', message: 'connection lost' } } });
    await assert.rejects(recordWebhookEvent(db, ROW, BODY), /connection lost/);
    const fallbackFails = fakeDb({ upsertResult: { data: null, error: { code: '42703', message: 'x' } }, insertResult: { error: { message: 'disk full' } } });
    await assert.rejects(recordWebhookEvent(fallbackFails, ROW, BODY), /disk full/);
});

test('recordWebhookEvent: an event without a reliable timestamp is stored without a key', async () => {
    const body = { ...BODY, event: { ...BODY.event, timestamp: 'garbage' } };
    const db = fakeDb({ upsertResult: null });
    assert.deepEqual(await recordWebhookEvent(db, parseWebhookEvent(body), body), { inserted: true });
    assert.equal(db.calls[0][0], 'insert');
});
