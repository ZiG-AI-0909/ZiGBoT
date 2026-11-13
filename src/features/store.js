/**
 * Storage for the optional features (table zb_feature_records): small JSON
 * records named by guild + kind + key, e.g. ("123...", "birthday", userId).
 *
 * Every read and write names the guild, and a returned row is checked
 * against it, so one server can never see another's records. Changes that
 * depend on the old value (votes, XP, coins) go through mutate(), which
 * retries on a version conflict instead of overwriting a concurrent change.
 *
 * SupabaseFeatureStore talks to Supabase with the service role (bot only).
 * MemoryFeatureStore has the same interface: used by the tests, and by the
 * bot when Supabase is not configured (nothing then survives a restart).
 */
const SNOWFLAKE = /^\d{17,20}$/;
const KIND = /^[a-z][a-z0-9_]{0,39}$/;

function check(guildId, kind, key) {
    if (!SNOWFLAKE.test(String(guildId || ''))) throw new Error('Invalid guild id.');
    if (!KIND.test(String(kind || ''))) throw new Error('Invalid record kind.');
    if (key !== undefined && (typeof key !== 'string' || key.length < 1 || key.length > 120)) throw new Error('Invalid record key.');
}

class BaseFeatureStore {
    /**
     * Read, change, write back; retried when someone else changed the record
     * in between. fn(data|null) returns the new data, or undefined to leave
     * it alone. Returns { record, changed }.
     */
    async mutate(guildId, kind, key, fn, { attempts = 6, dueAt } = {}) {
        for (let i = 0; i < attempts; i += 1) {
            const current = await this.get(guildId, kind, key);
            const next = await fn(current ? structuredClone(current.data) : null, current);
            if (next === undefined) return { record: current, changed: false };
            const saved = current
                ? await this.update(guildId, kind, key, current.version, next, { dueAt: dueAt === undefined ? current.dueAt : dueAt })
                : await this.create(guildId, kind, key, next, { dueAt: dueAt ?? null });
            if (saved) return { record: saved, changed: true };
        }
        throw new Error('Record is busy, try again.');
    }
}

class MemoryFeatureStore extends BaseFeatureStore {
    constructor({ now = () => Date.now() } = {}) {
        super();
        this.rows = new Map();
        this.now = now;
        this.enabled = true;
        this.persistent = false;
    }

    id(guildId, kind, key) { return `${guildId}\n${kind}\n${key}`; }
    view(row) { return row ? { guildId: row.guildId, kind: row.kind, key: row.key, data: structuredClone(row.data), version: row.version, dueAt: row.dueAt, updatedAt: row.updatedAt, createdAt: row.createdAt } : null; }

    async get(guildId, kind, key) {
        check(guildId, kind, key);
        return this.view(this.rows.get(this.id(guildId, kind, key)));
    }

    async create(guildId, kind, key, data, { dueAt = null } = {}) {
        check(guildId, kind, key);
        const id = this.id(guildId, kind, key);
        if (this.rows.has(id)) return null;
        const t = this.now();
        this.rows.set(id, { guildId: String(guildId), kind, key, data: structuredClone(data), version: 1, dueAt, createdAt: t, updatedAt: t });
        return this.view(this.rows.get(id));
    }

    async put(guildId, kind, key, data, { dueAt = null } = {}) {
        check(guildId, kind, key);
        const id = this.id(guildId, kind, key);
        const old = this.rows.get(id);
        const t = this.now();
        this.rows.set(id, { guildId: String(guildId), kind, key, data: structuredClone(data), version: (old?.version || 0) + 1, dueAt, createdAt: old?.createdAt || t, updatedAt: t });
        return this.view(this.rows.get(id));
    }

    async update(guildId, kind, key, expectedVersion, data, { dueAt = null } = {}) {
        check(guildId, kind, key);
        const row = this.rows.get(this.id(guildId, kind, key));
        if (!row || row.version !== expectedVersion) return null;
        Object.assign(row, { data: structuredClone(data), version: row.version + 1, dueAt, updatedAt: this.now() });
        return this.view(row);
    }

    async remove(guildId, kind, key) {
        check(guildId, kind, key);
        return this.rows.delete(this.id(guildId, kind, key));
    }

    async list(guildId, kind, { limit = 100 } = {}) {
        check(guildId, kind);
        return [...this.rows.values()].filter((r) => r.guildId === String(guildId) && r.kind === kind)
            .sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit).map((r) => this.view(r));
    }

    /** Scheduled records that are due, oldest first, across all servers. */
    async due(nowMs, { limit = 50 } = {}) {
        return [...this.rows.values()].filter((r) => r.dueAt !== null && r.dueAt <= nowMs)
            .sort((a, b) => a.dueAt - b.dueAt).slice(0, limit).map((r) => this.view(r));
    }
}

class SupabaseFeatureStore extends BaseFeatureStore {
    constructor({ supabaseUrl, serviceRoleKey, fetchImpl = globalThis.fetch } = {}) {
        super();
        this.baseUrl = supabaseUrl ? String(supabaseUrl).replace(/\/+$/, '') : '';
        this.key = serviceRoleKey || '';
        this.fetch = fetchImpl;
        this.enabled = Boolean(this.baseUrl && this.key && typeof this.fetch === 'function');
        this.persistent = true;
    }

    async request(query, { method = 'GET', body, prefer = 'return=representation' } = {}) {
        if (!this.enabled) throw new Error('Feature storage is unavailable.');
        const response = await this.fetch(`${this.baseUrl}/rest/v1/zb_feature_records${query ? `?${query}` : ''}`, {
            method,
            headers: { apikey: this.key, Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json', Prefer: prefer },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(8000)
        });
        if (!response.ok) {
            const detail = (await response.text().catch(() => '')).slice(0, 200);
            throw new Error(`Feature storage ${method} failed (${response.status}): ${detail}`);
        }
        if (response.status === 204) return [];
        const text = await response.text();
        const rows = text ? JSON.parse(text) : [];
        return Array.isArray(rows) ? rows : [];
    }

    view(row) {
        const ms = (value) => (value ? Date.parse(value) : null);
        return { guildId: String(row.guild_id), kind: row.kind, key: row.key, data: row.data || {}, version: row.version, dueAt: ms(row.due_at), updatedAt: ms(row.updated_at), createdAt: ms(row.created_at) };
    }

    where(guildId, kind, key) {
        const query = new URLSearchParams({ guild_id: `eq.${guildId}`, kind: `eq.${kind}` });
        if (key !== undefined) query.set('key', `eq.${key}`);
        return query;
    }

    // A row for another guild must never be returned, whatever the database says.
    own(rows, guildId) {
        return rows.filter((row) => String(row.guild_id) === String(guildId)).map((row) => this.view(row));
    }

    async get(guildId, kind, key) {
        check(guildId, kind, key);
        const query = this.where(guildId, kind, key);
        query.set('select', '*');
        query.set('limit', '1');
        return this.own(await this.request(query.toString()), guildId)[0] || null;
    }

    row(guildId, kind, key, data, dueAt) {
        return { guild_id: String(guildId), kind, key, data, due_at: dueAt === null || dueAt === undefined ? null : new Date(dueAt).toISOString(), updated_at: new Date().toISOString() };
    }

    async create(guildId, kind, key, data, { dueAt = null } = {}) {
        check(guildId, kind, key);
        const rows = await this.request('on_conflict=guild_id,kind,key', { method: 'POST', body: [this.row(guildId, kind, key, data, dueAt)], prefer: 'resolution=ignore-duplicates,return=representation' });
        return this.own(rows, guildId)[0] || null;
    }

    async put(guildId, kind, key, data, { dueAt = null } = {}) {
        check(guildId, kind, key);
        const rows = await this.request('on_conflict=guild_id,kind,key', { method: 'POST', body: [this.row(guildId, kind, key, data, dueAt)], prefer: 'resolution=merge-duplicates,return=representation' });
        return this.own(rows, guildId)[0] || null;
    }

    async update(guildId, kind, key, expectedVersion, data, { dueAt = null } = {}) {
        check(guildId, kind, key);
        if (!Number.isInteger(expectedVersion)) throw new Error('Invalid record version.');
        const query = this.where(guildId, kind, key);
        query.set('version', `eq.${expectedVersion}`);
        const { guild_id: _g, kind: _k, key: _key, ...patch } = this.row(guildId, kind, key, data, dueAt);
        const rows = await this.request(query.toString(), { method: 'PATCH', body: { ...patch, version: expectedVersion + 1 } });
        return this.own(rows, guildId)[0] || null;
    }

    async remove(guildId, kind, key) {
        check(guildId, kind, key);
        const rows = await this.request(this.where(guildId, kind, key).toString(), { method: 'DELETE' });
        return rows.length > 0;
    }

    async list(guildId, kind, { limit = 100 } = {}) {
        check(guildId, kind);
        const query = this.where(guildId, kind);
        query.set('select', '*');
        query.set('order', 'updated_at.desc');
        query.set('limit', String(Math.min(Math.max(1, limit), 1000)));
        return this.own(await this.request(query.toString()), guildId);
    }

    async due(nowMs, { limit = 50 } = {}) {
        const query = new URLSearchParams({ select: '*', due_at: `lte.${new Date(nowMs).toISOString()}`, order: 'due_at.asc', limit: String(limit) });
        return (await this.request(query.toString())).map((row) => this.view(row));
    }
}

module.exports = { SupabaseFeatureStore, MemoryFeatureStore };
