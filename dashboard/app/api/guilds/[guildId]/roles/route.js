import shared from '@/lib/shared';
import { handler, json, readJson, HttpError } from '@/lib/http';
import { requireGuildAdmin } from '@/lib/auth';
import { assignableRoles } from '@/lib/discord';
import { loadMappings } from '@/lib/guildData';
import { loadPlan } from '@/lib/billing';

const { validateRoleMappings, mappingsPremiumError } = shared;

export const dynamic = 'force-dynamic';

// GET: live roles from Discord (synchronised on every request) + saved mappings.
export const GET = handler(async (_request, { params }) => {
    const { guildId } = await params;
    const { supabase, guild } = await requireGuildAdmin(guildId);
    return json({ roles: assignableRoles(guild), mappings: await loadMappings(supabase, guild.id) });
});

// PUT: replace the full mapping set. Role ids are checked against the live
// role list of THIS guild; names come from Discord, not the request.
export const PUT = handler(async (request, { params }) => {
    const { guildId } = await params;
    const { supabase, guild } = await requireGuildAdmin(guildId);
    const body = await readJson(request);
    const liveRoles = (guild.roles || []).filter((r) => !r.managed);
    const result = validateRoleMappings(body?.mappings, {
        roleIds: new Set(liveRoles.map((r) => String(r.id))),
        roleNames: new Map(liveRoles.map((r) => [String(r.id), r.name])),
        guildId: String(guild.id)
    });
    if (!result.ok) throw new HttpError(422, 'Some role mappings need fixing.', { mappingErrors: result.errors });

    const gid = String(guild.id);
    // Free servers are capped; a lapsed server may keep (not grow) what it saved while Premium.
    const plan = await loadPlan(guild);
    if (!plan.premium && mappingsPremiumError(result.value)) {
        const { count } = await supabase.from('zb_role_mappings').select('role_id', { count: 'exact', head: true }).eq('guild_id', gid);
        if (result.value.length > (count || 0)) throw new HttpError(403, mappingsPremiumError(result.value), { mappingErrors: [{ _: mappingsPremiumError(result.value) }] });
    }
    const rows = result.value.map((m) => ({ ...m, guild_id: gid }));
    if (rows.length > 0) {
        const { error } = await supabase.from('zb_role_mappings').upsert(rows, { onConflict: 'guild_id,role_id' });
        if (error) throw new Error(`Role mapping save failed: ${error.message}`);
    }
    const keep = rows.map((r) => r.role_id);
    let del = supabase.from('zb_role_mappings').delete().eq('guild_id', gid);
    if (keep.length > 0) del = del.not('role_id', 'in', `(${keep.join(',')})`);
    const { error: deleteError } = await del;
    if (deleteError) throw new Error(`Role mapping cleanup failed: ${deleteError.message}`);

    return json({ mappings: await loadMappings(supabase, gid) });
});
