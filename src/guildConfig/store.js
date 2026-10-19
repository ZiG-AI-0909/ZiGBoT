/**
 * Per-server configuration store for the bot worker.
 *
 * Reads zb_guild_configs / zb_role_mappings from Supabase through PostgREST
 * with the SERVICE-ROLE key (server-side only, never shipped to a browser).
 *
 * Isolation: every read and write is keyed by the guild id of the Discord
 * event being handled; the cache is a Map keyed by guild id, so one server's
 * settings can never be served for another.
 *
 * Resilience: a Supabase outage or bad row must never crash the bot or stop
 * replies. Order of fallback: fresh cache -> DB -> stale cache -> safe
 * defaults (legacy env-driven defaults for the home server).
 *
 * When SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set the store runs in
 * 'legacy' mode: every server behaves exactly as the pre-multi-server bot did
 * (env-driven), so existing single-server deployments keep working unchanged.
 */
const {
    defaultGuildConfig,
    sanitizeStoredConfig,
    sanitizeStoredMappings,
    isPremiumActive,
    applyPlanToConfig,
    applyPlanToMappings,
    CONFIG_CACHE_TTL_MS
} = require('../../dashboard/lib/shared');

const SNOWFLAKE = /^\d{17,20}$/;
// Columns added by later migrations: seeding leaves them to their database
// defaults, so it keeps working before those migrations are applied.
const SETUP_FIELDS = [
    'owner_pronouns', 'male_role_ids', 'female_role_ids', 'adult_role_ids', 'minor_role_ids',
    'music_dj_role_ids', 'music_channel_id', 'music_idle_minutes', 'music_default_volume',
    'voice_speaker', 'voice_pace', 'voice_language', 'voice_speak_replies'
];
const SETUP_PRONOUNS = ['she/her', 'he/him', 'they/them'];

function isHomeGuild(guild, settings) {
    if (!guild) return false;
    const homeIds = settings.homeGuildIds || [];
    if (homeIds.includes(String(guild.id))) return true;
    return Boolean(settings.serverOwnerId) && guild.ownerId === settings.serverOwnerId;
}

function legacyContext(guild, settings) {
    const home = isHomeGuild(guild, settings);
    return {
        mode: 'legacy',
        source: 'env',
        guildId: String(guild?.id || ''),
        isHomeGuild: home,
        // Legacy mode = pre-multi-server behaviour for every server (no plans).
        premium: true,
        config: defaultGuildConfig({ guildId: guild?.id, legacy: true, legacySettings: settings }),
        mappings: []
    };
}

class GuildConfigStore {
    constructor({ settings, supabaseUrl, serviceRoleKey, fetchImpl = globalThis.fetch, ttlMs = CONFIG_CACHE_TTL_MS, logger = console, now = () => Date.now() } = {}) {
        this.settings = settings || {};
        this.baseUrl = supabaseUrl ? String(supabaseUrl).replace(/\/+$/, '') : '';
        this.key = serviceRoleKey || '';
        this.fetch = fetchImpl;
        this.ttlMs = ttlMs;
        this.logger = logger;
        this.now = now;
        this.cache = new Map(); // guildId -> { value, expiresAt }
        this.inflight = new Map();
        this.enabled = Boolean(this.baseUrl && this.key && typeof this.fetch === 'function');
        this.lastError = null;
    }

    get mode() {
        return this.enabled ? 'multi' : 'legacy';
    }

    async request(path, { method = 'GET', body, prefer } = {}) {
        const headers = {
            apikey: this.key,
            Authorization: `Bearer ${this.key}`,
            'Content-Type': 'application/json'
        };
        if (prefer) headers.Prefer = prefer;
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        const timer = controller ? setTimeout(() => controller.abort(), 8000) : null;
        try {
            const response = await this.fetch(`${this.baseUrl}/rest/v1/${path}`, {
                method,
                headers,
                body: body === undefined ? undefined : JSON.stringify(body),
                signal: controller?.signal
            });
            if (!response.ok) {
                const text = await response.text().catch(() => '');
                throw new Error(`Supabase ${method} ${path.split('?')[0]} failed: ${response.status} ${text.slice(0, 200)}`);
            }
            if (response.status === 204) return null;
            const text = await response.text();
            return text ? JSON.parse(text) : null;
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    invalidate(guildId) {
        if (guildId) this.cache.delete(String(guildId));
        else this.cache.clear();
    }

    /** Never throws. Always returns a usable, sanitized context for THIS guild. */
    async getGuildContext(guild) {
        if (!guild?.id) return null;
        if (!this.enabled) return legacyContext(guild, this.settings);
        const guildId = String(guild.id);
        const cached = this.cache.get(guildId);
        if (cached && cached.expiresAt > this.now()) return cached.value;
        if (this.inflight.has(guildId)) return this.inflight.get(guildId);

        const pending = this.load(guild)
            .then((value) => {
                this.cache.set(guildId, { value, expiresAt: this.now() + this.ttlMs });
                return value;
            })
            .catch((error) => {
                this.lastError = error.message;
                this.logger.error?.(`[ZiGBoT CONFIG] Load failed for guild ${guildId}: ${error.message}`);
                if (cached) return { ...cached.value, source: 'stale-cache' };
                return this.defaultContext(guild, 'default-after-error');
            })
            .finally(() => this.inflight.delete(guildId));
        this.inflight.set(guildId, pending);
        return pending;
    }

    defaultContext(guild, source = 'default') {
        const home = isHomeGuild(guild, this.settings);
        return {
            mode: 'multi',
            source,
            guildId: String(guild.id),
            isHomeGuild: home,
            // The owner's home server is always Premium.
            premium: home,
            config: defaultGuildConfig({ guildId: guild.id, legacy: home, legacySettings: this.settings }),
            mappings: []
        };
    }

    async load(guild) {
        const guildId = String(guild.id);
        if (!SNOWFLAKE.test(guildId)) return this.defaultContext(guild);
        const id = encodeURIComponent(guildId);
        const [configs, mappings, subscription] = await Promise.all([
            this.request(`zb_guild_configs?guild_id=eq.${id}&select=*`),
            this.request(`zb_role_mappings?guild_id=eq.${id}&select=*&order=priority.desc`),
            this.loadSubscription(guildId)
        ]);
        const row = Array.isArray(configs) ? configs[0] : null;
        if (!row) {
            // Unknown server (e.g. added while the bot was offline): seed it.
            await this.ensureGuild(guild).catch((error) => {
                this.logger.error?.(`[ZiGBoT CONFIG] Could not seed guild ${guildId}: ${error.message}`);
            });
            return this.defaultContext(guild, 'default-seeded');
        }
        // Defence in depth: a row for another guild must never be used.
        if (String(row.guild_id) !== guildId) throw new Error('Config row guild mismatch');
        const home = isHomeGuild(guild, this.settings);
        const premium = home || isPremiumActive(subscription, this.now());
        // Free servers: Premium-only settings are ignored here, even if they
        // were saved while the server was Premium.
        return {
            mode: 'multi',
            source: 'db',
            guildId,
            isHomeGuild: home,
            premium,
            config: applyPlanToConfig(sanitizeStoredConfig(row, { guildId }), premium),
            mappings: applyPlanToMappings(sanitizeStoredMappings((mappings || []).filter((m) => String(m.guild_id) === guildId)), premium)
        };
    }

    /**
     * The server's subscription row, or null. A failure here (e.g. the
     * Premium migration not applied yet) must not break config loading: the
     * server is then treated as free until the next load.
     */
    async loadSubscription(guildId) {
        try {
            const rows = await this.request(`zb_guild_subscriptions?guild_id=eq.${encodeURIComponent(guildId)}&select=guild_id,status,current_period_end,plan_period`);
            const row = Array.isArray(rows) ? rows[0] : null;
            return row && String(row.guild_id) === guildId ? row : null;
        } catch (error) {
            this.logger.error?.(`[ZiGBoT CONFIG] Subscription lookup failed for guild ${guildId}: ${error.message}`);
            return null;
        }
    }

    /** Upsert guild metadata and create a default config if none exists. */
    async ensureGuild(guild) {
        if (!this.enabled || !guild?.id || !SNOWFLAKE.test(String(guild.id))) return false;
        const guildId = String(guild.id);
        await this.request('zb_guilds?on_conflict=guild_id', {
            method: 'POST',
            prefer: 'resolution=merge-duplicates,return=minimal',
            body: [{
                guild_id: guildId,
                name: String(guild.name || '').slice(0, 100),
                icon: guild.icon || null,
                owner_discord_id: SNOWFLAKE.test(String(guild.ownerId || '')) ? String(guild.ownerId) : null,
                bot_installed: true,
                removed_at: null,
                updated_at: new Date(this.now()).toISOString()
            }]
        });
        const home = isHomeGuild(guild, this.settings);
        const defaults = defaultGuildConfig({ guildId, legacy: home, legacySettings: this.settings });
        delete defaults.version;
        // /setup columns keep their database defaults (and seeding keeps
        // working on a database that has not run the setup migration yet).
        for (const key of SETUP_FIELDS) delete defaults[key];
        await this.request('zb_guild_configs?on_conflict=guild_id', {
            method: 'POST',
            prefer: 'resolution=ignore-duplicates,return=minimal',
            body: [defaults]
        });
        this.invalidate(guildId);
        return true;
    }

    async markRemoved(guildId) {
        if (!this.enabled || !SNOWFLAKE.test(String(guildId || ''))) return false;
        await this.request(`zb_guilds?guild_id=eq.${encodeURIComponent(String(guildId))}`, {
            method: 'PATCH',
            prefer: 'return=minimal',
            body: { bot_installed: false, removed_at: new Date(this.now()).toISOString(), updated_at: new Date(this.now()).toISOString() }
        });
        this.invalidate(guildId);
        return true;
    }

    /**
     * Save the /setup answers for THIS guild. Only the language and the
     * setup columns are written; everything else an admin set stays as is.
     */
    async saveSetup(guild, { language, ownerPronouns, maleRoleIds, femaleRoleIds, adultRoleIds, minorRoleIds }) {
        if (!this.enabled) throw new Error('Server settings are not available on this bot (no database configured).');
        const guildId = String(guild?.id || '');
        if (!SNOWFLAKE.test(guildId)) throw new Error('Invalid server.');
        const ids = (list) => [...new Set((list || []).map(String).filter((id) => SNOWFLAKE.test(id) && id !== guildId))].slice(0, 10);
        const body = {
            language: language === 'English' ? 'English' : 'Hinglish',
            owner_pronouns: SETUP_PRONOUNS.includes(ownerPronouns) ? ownerPronouns : null,
            male_role_ids: ids(maleRoleIds),
            female_role_ids: ids(femaleRoleIds),
            adult_role_ids: ids(adultRoleIds),
            minor_role_ids: ids(minorRoleIds),
            updated_at: new Date(this.now()).toISOString()
        };
        await this.ensureGuild(guild);
        await this.request(`zb_guild_configs?guild_id=eq.${encodeURIComponent(guildId)}`, {
            method: 'PATCH',
            prefer: 'return=minimal',
            body
        });
        this.invalidate(guildId);
        return body;
    }

    async heartbeat({ guildCount = 0, version = '' } = {}) {
        if (!this.enabled) return false;
        await this.request('zb_bot_heartbeat?on_conflict=id', {
            method: 'POST',
            prefer: 'resolution=merge-duplicates,return=minimal',
            body: [{ id: 'main', last_seen_at: new Date(this.now()).toISOString(), guild_count: guildCount, version: String(version).slice(0, 40) }]
        });
        return true;
    }
}

module.exports = { GuildConfigStore, isHomeGuild, legacyContext };
