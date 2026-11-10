/**
 * Discord webhook events (Developer Portal -> Webhooks): signature check,
 * event parsing and the creator's notification text.
 *
 * Discord signs every delivery with Ed25519 over timestamp + raw body, using
 * the application's private key; we check it with the PUBLIC key from the
 * portal (DISCORD_PUBLIC_KEY). CommonJS like razorpaySignature.js, so the
 * test suite can run it.
 */
const crypto = require('node:crypto');

// DER header that turns a raw 32-byte Ed25519 public key into SPKI.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const MAX_SKEW_SECONDS = 5 * 60;
const SNOWFLAKE = /^\d{17,20}$/;
const EVENT_TYPES = Object.freeze(['APPLICATION_AUTHORIZED', 'APPLICATION_DEAUTHORIZED']);

function verifyDiscordSignature(rawBody, signature, timestamp, publicKeyHex, { now = Date.now() } = {}) {
    if (typeof rawBody !== 'string') return false;
    if (!/^[a-f0-9]{64}$/i.test(String(publicKeyHex || ''))) return false;
    if (!/^[a-f0-9]{128}$/i.test(String(signature || ''))) return false;
    if (!/^\d{1,12}$/.test(String(timestamp || ''))) return false;
    // A captured delivery cannot be replayed later.
    if (Math.abs(now / 1000 - Number(timestamp)) > MAX_SKEW_SECONDS) return false;
    try {
        const key = crypto.createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKeyHex, 'hex')]), format: 'der', type: 'spki' });
        return crypto.verify(null, Buffer.from(String(timestamp) + rawBody, 'utf8'), key, Buffer.from(signature, 'hex'));
    } catch {
        return false;
    }
}

const text = (value, max = 100) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null);
const id = (value) => (SNOWFLAKE.test(String(value ?? '')) ? String(value) : null);

/** A zb_app_events row for an install event, or null for anything else. */
function parseWebhookEvent(body) {
    const event = body?.event;
    if (body?.type !== 1 || !EVENT_TYPES.includes(event?.type)) return null;
    const data = event.data || {};
    const user = data.user || {};
    const occurred = Date.parse(event.timestamp);
    return {
        event_type: event.type,
        integration_type: [0, 1].includes(data.integration_type) ? data.integration_type : null,
        user_discord_id: id(user.id),
        user_name: text(user.global_name) || text(user.username),
        guild_id: id(data.guild?.id),
        guild_name: text(data.guild?.name),
        scopes: Array.isArray(data.scopes) ? data.scopes.filter((s) => typeof s === 'string').slice(0, 20).map((s) => s.slice(0, 60)) : [],
        occurred_at: new Date(Number.isFinite(occurred) ? occurred : Date.now()).toISOString()
    };
}

/** The DM sent to the bot creator. Names are shown as plain text, never as mentions. */
function describeEvent(row) {
    const who = row.user_name ? `**${row.user_name}**${row.user_discord_id ? ` (\`${row.user_discord_id}\`)` : ''}` : 'Someone';
    const where = row.guild_name ? `**${row.guild_name}**${row.guild_id ? ` (\`${row.guild_id}\`)` : ''}` : (row.guild_id ? `\`${row.guild_id}\`` : null);
    if (row.event_type === 'APPLICATION_AUTHORIZED') {
        if (row.integration_type === 1) return `🟢 ${who} added ZiGBoT to their Discord account.`;
        return `🟢 ${who} added ZiGBoT to ${where || 'a server'}.`;
    }
    if (row.event_type === 'APPLICATION_DEAUTHORIZED') return `🔴 ${who} removed ZiGBoT from their Discord account.`;
    if (row.event_type === 'GUILD_REMOVED') return `🔴 ZiGBoT was removed from ${where || 'a server'}.`;
    return null;
}

module.exports = { verifyDiscordSignature, parseWebhookEvent, describeEvent, EVENT_TYPES };
