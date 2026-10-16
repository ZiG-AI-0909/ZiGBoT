import shared from '@/lib/shared';
import { handler, json, readJson, HttpError } from '@/lib/http';
import { requireGuildAdmin } from '@/lib/auth';
import { getChannels } from '@/lib/discord';
import { loadConfig } from '@/lib/guildData';

const { validateGuildConfig, sanitizeStoredConfig } = shared;

export const dynamic = 'force-dynamic';

export const GET = handler(async (_request, { params }) => {
    const { guildId } = await params;
    const { supabase, guild } = await requireGuildAdmin(guildId);
    return json({ config: await loadConfig(supabase, guild) });
});

// PUT: validate against LIVE channel ids of this guild, then write through
// the user's RLS-scoped client (RLS re-checks the fresh admin verification).
export const PUT = handler(async (request, { params }) => {
    const { guildId } = await params;
    const { supabase, guild } = await requireGuildAdmin(guildId);
    const body = await readJson(request);
    const channels = await getChannels(guild.id);
    const channelIds = new Set(channels.map((c) => String(c.id)));
    const result = validateGuildConfig(body?.config, { channelIds, guildId: String(guild.id) });
    if (!result.ok) throw new HttpError(422, 'Some settings need fixing.', { fieldErrors: result.errors });

    // Optimistic concurrency: refuse to overwrite a newer save from another admin.
    let query = supabase.from('zb_guild_configs').update(result.value).eq('guild_id', String(guild.id));
    if (Number.isInteger(body?.expectedVersion)) query = query.eq('version', body.expectedVersion);
    const { data, error } = await query.select('*');
    if (error) throw new Error(`Config update failed: ${error.message}`);
    if (!data || data.length === 0) {
        throw new HttpError(409, 'Someone else saved changes to this server in the meantime. Reload to see the latest settings.');
    }
    const row = data[0];
    return json({ config: { ...sanitizeStoredConfig(row, { guildId: String(guild.id) }), version: row.version, updated_at: row.updated_at } });
});
