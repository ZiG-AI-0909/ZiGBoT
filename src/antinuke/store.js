/**
 * Anti-Nuke persistence through the bot's existing Supabase REST client
 * (GuildConfigStore.request, service role). Without Supabase (legacy mode)
 * monitoring and alerts still work with default settings; nothing is stored.
 * Every read and write is keyed by the guild id of the Discord event.
 */
const { sanitizeAntiNukeSettings, defaultAntiNukeSettings, ANTINUKE_LIMITS } = require('../../dashboard/lib/shared/antinuke');

const SNOWFLAKE = /^\d{17,20}$/;
const enc = encodeURIComponent;

function createAntiNukeStore({ guildStore, ttlMs = 60_000, now = () => Date.now(), logger = console }) {
    const enabled = Boolean(guildStore?.enabled);
    const cache = new Map();
    const request = (path, options) => guildStore.request(path, options);
    const id = (value) => {
        if (!SNOWFLAKE.test(String(value))) throw new Error('Invalid guild id.');
        return String(value);
    };

    async function getSettings(guildId) {
        const key = id(guildId);
        const hit = cache.get(key);
        if (hit && hit.expiresAt > now()) return hit.value;
        if (!enabled) return defaultAntiNukeSettings(key);
        try {
            const rows = await request(`zb_security_settings?guild_id=eq.${enc(key)}&select=*`);
            const value = sanitizeAntiNukeSettings(Array.isArray(rows) ? rows[0] : null, key);
            cache.set(key, { value, expiresAt: now() + ttlMs });
            return value;
        } catch (error) {
            logger.error?.(`[ZiGBoT ANTINUKE] Settings read failed for ${key}: ${String(error.message).slice(0, 120)}`);
            // Monitoring never stops: stale settings, else safe defaults.
            return hit?.value || defaultAntiNukeSettings(key);
        }
    }

    const invalidate = (guildId) => cache.delete(String(guildId));

    /** Create the settings row with defaults if missing (never overwrites admin choices). */
    async function ensureSettings(guildId) {
        if (!enabled) return false;
        await request('zb_security_settings?on_conflict=guild_id', {
            method: 'POST',
            prefer: 'resolution=ignore-duplicates,return=minimal',
            body: [{ guild_id: id(guildId) }]
        });
        return true;
    }

    /** Remember an alert channel ZiGBoT created, unless an admin already picked one. */
    async function setAlertChannelIfUnset(guildId, channelId) {
        if (!enabled) return false;
        await request(`zb_security_settings?guild_id=eq.${enc(id(guildId))}&alert_channel_id=is.null`, {
            method: 'PATCH',
            prefer: 'return=minimal',
            body: { alert_channel_id: id(channelId), updated_at: new Date(now()).toISOString() }
        });
        invalidate(guildId);
        return true;
    }

    async function recordIncident(row) {
        if (!enabled) return null;
        const rows = await request('zb_security_events', { method: 'POST', prefer: 'return=representation', body: [{ ...row, guild_id: id(row.guild_id) }] });
        return Array.isArray(rows) ? rows[0] : null;
    }

    async function updateIncident(guildId, incidentId, fields) {
        if (!enabled || !Number.isInteger(Number(incidentId))) return;
        await request(`zb_security_events?id=eq.${Number(incidentId)}&guild_id=eq.${enc(id(guildId))}`, {
            method: 'PATCH',
            prefer: 'return=minimal',
            body: { ...fields, updated_at: new Date(now()).toISOString() }
        });
    }

    /** A suppressed repeat: count it on the incident that was already alerted. */
    async function bumpOccurrences(guildId, incidentId) {
        if (!enabled || !Number.isInteger(Number(incidentId))) return;
        const rows = await request(`zb_security_events?id=eq.${Number(incidentId)}&guild_id=eq.${enc(id(guildId))}&select=occurrences`);
        const current = Number(Array.isArray(rows) ? rows[0]?.occurrences : 0) || 1;
        await updateIncident(guildId, incidentId, { occurrences: current + 1 });
    }

    async function upsertStatus(guildId, fields) {
        if (!enabled) return;
        await request('zb_security_status?on_conflict=guild_id', {
            method: 'POST',
            prefer: 'resolution=merge-duplicates,return=minimal',
            body: [{ guild_id: id(guildId), ...fields }]
        });
    }

    /** Delete incidents older than the retention period (all servers). */
    async function purgeOld() {
        if (!enabled) return;
        const cutoff = new Date(now() - ANTINUKE_LIMITS.retentionDays * 86_400_000).toISOString();
        await request(`zb_security_events?created_at=lt.${enc(cutoff)}`, { method: 'DELETE', prefer: 'return=minimal' });
    }

    return { enabled, getSettings, invalidate, ensureSettings, setAlertChannelIfUnset, recordIncident, updateIncident, bumpOccurrences, upsertStatus, purgeOld };
}

module.exports = { createAntiNukeStore };
