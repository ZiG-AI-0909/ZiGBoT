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
