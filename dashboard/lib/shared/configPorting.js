/**
 * Server configuration export / import (Section M): a JSON backup of one
 * server's ZiGBoT settings, owner only (enforced by the routes).
 *
 * Export: every setting the editor knows (defaults' keys), never ids of
 * the row itself, version counters or timestamps, and nothing secret (the
 * config holds no tokens; custom bot identity and billing are separate
 * tables and are not included).
 * Import: the file is only parsed and narrowed here; the route then runs
 * the SAME validateGuildConfig + Premium checks as a normal save, against
 * the server's live channels and roles.
 */
const { defaultGuildConfig } = require('./defaults');

const FORMAT = 'zigbot-config';
const VERSION = 1;
const MAX_BYTES = 200 * 1024;
const NEVER = new Set(['guild_id', 'version', 'updated_at', 'updated_by', 'created_at', 'id']);

const allowedKeys = () => Object.keys(defaultGuildConfig({ guildId: '0' })).filter((key) => !NEVER.has(key));

function buildExport(config, { guildId, guildName = '', now = () => Date.now() } = {}) {
    const settings = {};
    for (const key of allowedKeys()) if (config && config[key] !== undefined) settings[key] = config[key];
    return { format: FORMAT, version: VERSION, exportedAt: new Date(now()).toISOString(), source: { guildId: String(guildId || ''), guildName: String(guildName || '').slice(0, 100) }, settings };
}

/** { config } for validateGuildConfig, or { error }. Unknown keys are dropped. */
function parseImport(text) {
    if (typeof text !== 'string' || !text.trim()) return { error: 'The file is empty.' };
    if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) return { error: 'The file is larger than 200 KB.' };
    let data;
    try {
        data = JSON.parse(text);
    } catch {
        return { error: 'The file is not valid JSON.' };
    }
    if (!data || typeof data !== 'object' || Array.isArray(data) || data.format !== FORMAT) return { error: 'This is not a ZiGBoT settings export.' };
    if (data.version !== VERSION) return { error: `Unsupported export version ${data.version}.` };
    if (!data.settings || typeof data.settings !== 'object' || Array.isArray(data.settings)) return { error: 'The export has no settings.' };
    const config = {};
    for (const key of allowedKeys()) {
        if (Object.prototype.hasOwnProperty.call(data.settings, key)) config[key] = data.settings[key];
    }
    return { config, sourceGuildId: String(data.source?.guildId || '') };
}

module.exports = { buildExport, parseImport, CONFIG_EXPORT_FORMAT: FORMAT, CONFIG_EXPORT_MAX_BYTES: MAX_BYTES };
