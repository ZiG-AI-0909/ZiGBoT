import shared from '@/lib/shared';
import { handler, json } from '@/lib/http';
import { requireGuildAdmin } from '@/lib/auth';
import { isHomeGuild } from '@/lib/guildData';

const { defaultGuildConfig, sanitizeStoredConfig } = shared;

export const dynamic = 'force-dynamic';

// POST: restore safe defaults for THIS guild (role mappings are kept).
export const POST = handler(async (_request, { params }) => {
    const { guildId } = await params;
    const { supabase, guild } = await requireGuildAdmin(guildId);
    const defaults = defaultGuildConfig({ guildId: String(guild.id), legacy: isHomeGuild(guild) });
    delete defaults.guild_id;
    delete defaults.version;
    const { data, error } = await supabase.from('zb_guild_configs').update(defaults).eq('guild_id', String(guild.id)).select('*');
    if (error) throw new Error(`Config reset failed: ${error.message}`);
    const row = data?.[0];
    return json({ config: row ? { ...sanitizeStoredConfig(row, { guildId: String(guild.id) }), version: row.version, updated_at: row.updated_at } : null });
});
