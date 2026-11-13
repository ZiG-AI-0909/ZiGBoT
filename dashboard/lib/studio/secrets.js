/**
 * Studio secrets (Phase 3): AES-256-GCM with STUDIO_SECRETS_KEY (32 bytes,
 * base64 or hex). The plaintext never leaves the server: API answers carry
 * only { configured, last4 }. Never log a value; errors never include one.
 * CommonJS so the tests can run it.
 */
const crypto = require('node:crypto');

const ENV_NAME = /^[A-Z][A-Z0-9_]{1,63}$/;
// Discord bot tokens: three base64url parts separated by dots.
const DISCORD_TOKEN = /^[A-Za-z0-9_-]{20,40}\.[A-Za-z0-9_-]{4,10}\.[A-Za-z0-9_-]{20,60}$/;

function keyFrom(raw) {
    const text = String(raw || '').trim();
    let key = null;
    if (/^[0-9a-f]{64}$/i.test(text)) key = Buffer.from(text, 'hex');
    else if (text) {
        try {
            key = Buffer.from(text, 'base64');
        } catch {
            key = null;
        }
    }
    if (!key || key.length !== 32) throw new Error('STUDIO_SECRETS_KEY must be 32 bytes (64 hex characters or base64). Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"');
    return key;
}

/** { ciphertext, iv, tag, last4 }, all base64 except last4. `aad` binds the value to its project + name. */
function encryptSecret(value, { key, aad }) {
    const plain = String(value ?? '');
    if (!plain) throw new Error('Nothing to encrypt.');
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', keyFrom(key), iv);
    cipher.setAAD(Buffer.from(String(aad), 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return { ciphertext: ciphertext.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), last4: plain.slice(-4) };
}

/** Throws (without revealing anything) if the key, the aad or the data is wrong. */
function decryptSecret(row, { key, aad }) {
    try {
        const decipher = crypto.createDecipheriv('aes-256-gcm', keyFrom(key), Buffer.from(row.iv, 'base64'));
        decipher.setAAD(Buffer.from(String(aad), 'utf8'));
        decipher.setAuthTag(Buffer.from(row.tag, 'base64'));
        return Buffer.concat([decipher.update(Buffer.from(row.ciphertext, 'base64')), decipher.final()]).toString('utf8');
    } catch {
        throw new Error('Secret could not be decrypted.');
    }
}

const aadFor = (projectId, name) => `studio:${projectId}:${name}`;

/** What the browser may see about a secret. */
const secretStatus = (row) => (row ? { configured: true, last4: row.last4, updatedAt: row.updated_at || null, meta: row.meta || {} } : { configured: false });

/** Masks anything token-shaped in a message before it is logged or returned. */
const redact = (text) => String(text ?? '').replace(/[A-Za-z0-9_-]{20,40}\.[A-Za-z0-9_-]{4,10}\.[A-Za-z0-9_-]{20,60}/g, '[redacted token]');

module.exports = { encryptSecret, decryptSecret, aadFor, secretStatus, redact, keyFrom, ENV_NAME, DISCORD_TOKEN };
