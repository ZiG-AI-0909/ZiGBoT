const SNOWFLAKE = /^\d{17,20}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TICKET_PATCH_FIELDS = new Set([
    'status', 'priority', 'claimed_by', 'participants', 'classification',
    'summary', 'suggested_reply', 'closed_at', 'rating', 'rated_at'
]);

class SupabaseTicketStore {
    constructor({ supabaseUrl, serviceRoleKey, fetchImpl = globalThis.fetch } = {}) {
        this.baseUrl = supabaseUrl ? String(supabaseUrl).replace(/\/+$/, '') : '';
        this.key = serviceRoleKey || '';
        this.fetch = fetchImpl;
        this.enabled = Boolean(this.baseUrl && this.key && typeof this.fetch === 'function');
    }

    assertEnabled() {
        if (!this.enabled) throw new Error('Ticket storage is unavailable. Configure Supabase and run the ticket migration.');
    }

    assertGuild(guildId) {
        if (!SNOWFLAKE.test(String(guildId || ''))) throw new Error('Invalid ticket guild ID.');
        return String(guildId);
    }

    assertTicketId(id) {
        if (!UUID.test(String(id || ''))) throw new Error('Invalid ticket ID.');
        return String(id);
    }

    async request(path, { method = 'GET', body } = {}) {
        this.assertEnabled();
        const headers = {
            apikey: this.key,
            Authorization: `Bearer ${this.key}`,
            'Content-Type': 'application/json',
            Prefer: 'return=representation'
        };
        const response = await this.fetch(`${this.baseUrl}/rest/v1/${path}`, {
            method,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(8000)
        });
        if (!response.ok) {
            const detail = (await response.text().catch(() => '')).slice(0, 200);
            throw new Error(`Ticket storage ${method} failed (${response.status}): ${detail}`);
        }
        if (response.status === 204) return null;
        const text = await response.text();
        return text ? JSON.parse(text) : null;
    }

    async findOpenTicket(guildId, openerId, categoryId) {
        const guild = this.assertGuild(guildId);
        if (!SNOWFLAKE.test(String(openerId)) || !SNOWFLAKE.test(String(categoryId))) throw new Error('Invalid ticket owner or category.');
        const query = new URLSearchParams({
            select: '*',
            guild_id: `eq.${guild}`,
            opener_id: `eq.${openerId}`,
            category_id: `eq.${categoryId}`,
            status: 'in.(open,closing)',
            limit: '1'
        });
        const rows = await this.request(`zb_tickets?${query}`);
        const row = Array.isArray(rows) ? rows[0] : null;
        return row && String(row.guild_id) === guild ? row : null;
    }

    async createTicket(record) {
        const guild = this.assertGuild(record?.guild_id);
        for (const field of ['channel_id', 'opener_id', 'category_id']) {
            if (!SNOWFLAKE.test(String(record?.[field] || ''))) throw new Error(`Invalid ticket ${field}.`);
        }
        const rows = await this.request('zb_tickets', {
            method: 'POST',
            body: [{
                guild_id: guild,
                channel_id: String(record.channel_id),
                opener_id: String(record.opener_id),
                category_id: String(record.category_id),
                status: 'open',
                priority: 'normal',
                participants: []
            }]
        });
        const row = Array.isArray(rows) ? rows[0] : null;
        if (!row || String(row.guild_id) !== guild) throw new Error('Ticket storage did not confirm the ticket creation.');
        return row;
    }

    async getTicket(guildId, id) {
        const guild = this.assertGuild(guildId);
        const ticketId = this.assertTicketId(id);
        const query = new URLSearchParams({ select: '*', guild_id: `eq.${guild}`, id: `eq.${ticketId}`, limit: '1' });
        const rows = await this.request(`zb_tickets?${query}`);
        const row = Array.isArray(rows) ? rows[0] : null;
        return row && String(row.guild_id) === guild ? row : null;
    }

    async getTicketByChannel(guildId, channelId) {
        const guild = this.assertGuild(guildId);
        if (!SNOWFLAKE.test(String(channelId || ''))) throw new Error('Invalid ticket channel ID.');
        const query = new URLSearchParams({ select: '*', guild_id: `eq.${guild}`, channel_id: `eq.${channelId}`, limit: '1' });
        const rows = await this.request(`zb_tickets?${query}`);
        const row = Array.isArray(rows) ? rows[0] : null;
        return row && String(row.guild_id) === guild ? row : null;
    }

    async claimTicket(guildId, id, userId) {
        const guild = this.assertGuild(guildId);
        const ticketId = this.assertTicketId(id);
        if (!SNOWFLAKE.test(String(userId || ''))) throw new Error('Invalid ticket claimant.');
        const query = new URLSearchParams({
            guild_id: `eq.${guild}`,
            id: `eq.${ticketId}`,
            status: 'eq.open',
            claimed_by: 'is.null'
        });
        const rows = await this.request(`zb_tickets?${query}`, {
            method: 'PATCH',
            body: { claimed_by: String(userId) }
        });
        const row = Array.isArray(rows) ? rows[0] : null;
        return row && String(row.guild_id) === guild ? row : null;
    }

    async updateTicket(guildId, id, patch, { expectedStatus = null } = {}) {
        const guild = this.assertGuild(guildId);
        const ticketId = this.assertTicketId(id);
        if (!patch || typeof patch !== 'object' || Array.isArray(patch) ||
            Object.keys(patch).length === 0 || Object.keys(patch).some((key) => !TICKET_PATCH_FIELDS.has(key))) {
            throw new Error('Invalid ticket update fields.');
        }
        if (patch.status !== undefined && !['open', 'closing', 'closed'].includes(patch.status)) throw new Error('Invalid ticket status.');
        if (patch.priority !== undefined && !['low', 'normal', 'high', 'urgent'].includes(patch.priority)) throw new Error('Invalid ticket priority.');
        if (patch.participants !== undefined && (!Array.isArray(patch.participants) || patch.participants.length > 20 ||
            patch.participants.some((userId) => !SNOWFLAKE.test(String(userId))))) throw new Error('Invalid ticket participants.');
        if (patch.claimed_by !== undefined && patch.claimed_by !== null && !SNOWFLAKE.test(String(patch.claimed_by))) {
            throw new Error('Invalid ticket claimant.');
        }
        const query = new URLSearchParams({ guild_id: `eq.${guild}`, id: `eq.${ticketId}` });
        if (expectedStatus) query.set('status', `eq.${expectedStatus}`);
        const rows = await this.request(`zb_tickets?${query}`, { method: 'PATCH', body: patch });
        const row = Array.isArray(rows) ? rows[0] : null;
        return row && String(row.guild_id) === guild ? row : null;
    }

    /** Number of tickets opened in this guild since an ISO time (analytics; read-only). */
    async countTicketsSince(guildId, sinceIso) {
        const guild = this.assertGuild(guildId);
        if (!this.enabled) return 0;
        const since = new Date(sinceIso);
        if (Number.isNaN(since.getTime())) throw new Error('Invalid ticket count time.');
        const query = new URLSearchParams({ select: 'id,guild_id', guild_id: `eq.${guild}`, created_at: `gte.${since.toISOString()}`, limit: '1000' });
        const rows = await this.request(`zb_tickets?${query}`);
        return Array.isArray(rows) ? rows.filter((row) => String(row.guild_id) === guild).length : 0;
    }

    async rateTicket(guildId, id, openerId, rating) {
        const guild = this.assertGuild(guildId);
        const ticketId = this.assertTicketId(id);
        if (!SNOWFLAKE.test(String(openerId)) || !Number.isInteger(rating) || rating < 1 || rating > 5) {
            throw new Error('Invalid ticket rating.');
        }
        const query = new URLSearchParams({
            guild_id: `eq.${guild}`,
            id: `eq.${ticketId}`,
            opener_id: `eq.${openerId}`,
            status: 'eq.closed',
            rating: 'is.null'
        });
        const rows = await this.request(`zb_tickets?${query}`, {
            method: 'PATCH',
            body: { rating, rated_at: new Date().toISOString() }
        });
        const row = Array.isArray(rows) ? rows[0] : null;
        return row && String(row.guild_id) === guild ? row : null;
    }
}

module.exports = { SupabaseTicketStore };
