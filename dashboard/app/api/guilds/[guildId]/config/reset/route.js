import shared from '@/lib/shared';
import { handler, json, HttpError } from '@/lib/http';
import { requireGuildAdmin } from '@/lib/auth';
import { isHomeGuild } from '@/lib/guildData';

const { defaultGuildConfig, sanitizeStoredConfig } = shared;

export const dynamic = 'force-dynamic';

// POST: restore safe defaults for THIS guild (role mappings are kept).
export const POST = handler(async (request, { params }) => {
    const { guildId } = await params;
    const { supabase, guild } = await requireGuildAdmin(guildId);
    const body = await request.json().catch(() => ({}));
    const defaults = defaultGuildConfig({ guildId: String(guild.id), legacy: isHomeGuild(guild) });
    delete defaults.guild_id;
    delete defaults.version;
    let query = supabase.from('zb_guild_configs').update(defaults).eq('guild_id', String(guild.id));
    if (Number.isInteger(body?.expectedVersion)) query = query.eq('version', body.expectedVersion);
    const { data, error } = await query.select('*');
    if (error) throw new Error(`Config reset failed: ${error.message}`);
    const row = data?.[0];
    if (!row) throw new HttpError(409, 'Someone else saved changes to this server in the meantime. Reload to see the latest settings.');
    return json({ config: row ? { ...sanitizeStoredConfig(row, { guildId: String(guild.id) }), version: row.version, updated_at: row.updated_at } : null });
});
