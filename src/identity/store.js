/**
 * Custom bot identity data for the bot worker: zb_guild_identity rows, the
 * block list, audit entries, and the private zb-identity storage bucket.
 * Uses the guild config store's Supabase connection (service role,
 * server-side only). Every read and write is keyed by one guild id.
 */
const { IDENTITY_BUCKET, IDENTITY_IMAGE_PATH } = require('../../dashboard/lib/shared');

const SNOWFLAKE = /^\d{17,20}$/;
const TABLE = 'zb_guild_identity';

function assertGuildId(guildId) {
    const id = String(guildId || '');
    if (!SNOWFLAKE.test(id)) throw new Error('Invalid guild id');
    return encodeURIComponent(id);
}

function createIdentityStore({ guildStore, fetchImpl = globalThis.fetch }) {
    const enabled = Boolean(guildStore?.enabled);
    const storageUrl = (path = '') => `${guildStore.baseUrl}/storage/v1/object/${IDENTITY_BUCKET}${path ? `/${path}` : ''}`;
    const authHeaders = () => ({ apikey: guildStore.key, Authorization: `Bearer ${guildStore.key}` });

    async function listRows() {
        const rows = await guildStore.request(`${TABLE}?select=*&order=guild_id.asc&limit=1000`);
        return Array.isArray(rows) ? rows : [];
    }

    async function getRow(guildId) {
        const id = assertGuildId(guildId);
        const rows = await guildStore.request(`${TABLE}?guild_id=eq.${id}&select=*`);
        const row = Array.isArray(rows) ? rows[0] : null;
        return row && String(row.guild_id) === String(guildId) ? row : null;
    }

    async function isGuildBlocked(guildId) {
        const id = assertGuildId(guildId);
        const rows = await guildStore.request(`zb_identity_blocks?kind=eq.guild&target_id=eq.${id}&select=id`);
        return Array.isArray(rows) && rows.length > 0;
    }

    async function updateRow(guildId, fields) {
        await guildStore.request(`${TABLE}?guild_id=eq.${assertGuildId(guildId)}`, {
            method: 'PATCH', prefer: 'return=minimal', body: { ...fields, updated_at: new Date().toISOString() }
        });
    }

    async function deleteRow(guildId) {
        await guildStore.request(`${TABLE}?guild_id=eq.${assertGuildId(guildId)}`, { method: 'DELETE', prefer: 'return=minimal' });
    }

    // actor_role: 'service_role' (automatic) or 'discord_admin' (/identity).
    async function audit({ guildId, action, actorRole = 'service_role', before = null, after = null }) {
        await guildStore.request('zb_config_audit_log', {
            method: 'POST',
            prefer: 'return=minimal',
            body: [{ guild_id: String(guildId), actor_user_id: null, actor_role: actorRole, action, table_name: TABLE, record_key: String(guildId), before, after }]
        });
    }

    async function downloadAvatar(path) {
        if (!IDENTITY_IMAGE_PATH.test(String(path || ''))) throw new Error('Invalid avatar path');
        const response = await fetchImpl(storageUrl(path), { headers: authHeaders() });
        if (!response.ok) throw new Error(`Avatar download failed: ${response.status}`);
        return Buffer.from(await response.arrayBuffer());
    }

    async function removeAvatars(paths) {
        const prefixes = [...new Set((paths || []).filter((p) => IDENTITY_IMAGE_PATH.test(String(p || ''))))];
        if (prefixes.length === 0) return;
        const response = await fetchImpl(storageUrl(), {
            method: 'DELETE',
            headers: { ...authHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ prefixes })
        });
        if (!response.ok) throw new Error(`Avatar delete failed: ${response.status}`);
    }

    return { enabled, listRows, getRow, isGuildBlocked, updateRow, deleteRow, audit, downloadAvatar, removeAvatars };
}

module.exports = { createIdentityStore };
