import { handler, json } from '@/lib/http';
import { requireGuildAdmin } from '@/lib/auth';
import { createServiceClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

const IGNORED = new Set(['updated_at', 'created_at', 'version', 'updated_by', 'id']);

function changedFields(before, after) {
    const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
    return [...keys].filter((key) => !IGNORED.has(key) && JSON.stringify(before?.[key]) !== JSON.stringify(after?.[key]));
}

// GET: the latest configuration changes for THIS guild (RLS-scoped read).
export const GET = handler(async (_request, { params }) => {
    const { guildId } = await params;
    const { supabase } = await requireGuildAdmin(guildId);
    const { data, error } = await supabase
        .from('zb_config_audit_log')
        .select('id, actor_user_id, actor_role, action, table_name, record_key, before, after, created_at')
        .eq('guild_id', String(guildId))
        .order('created_at', { ascending: false })
        .limit(50);
    if (error) throw new Error(`Audit read failed: ${error.message}`);

    // Resolve actor display names (service role, only for actors that appear in THIS guild's log).
    const actorIds = [...new Set((data || []).map((row) => row.actor_user_id).filter(Boolean))];
    const names = new Map();
    if (actorIds.length > 0) {
        const { data: profiles } = await createServiceClient().from('zb_profiles').select('user_id, username').in('user_id', actorIds);
        for (const p of profiles || []) names.set(p.user_id, p.username);
    }
    return json({
        entries: (data || []).map((row) => ({
            id: row.id,
            at: row.created_at,
            action: row.action,
            target: row.table_name === 'zb_role_mappings' ? `role mapping ${row.after?.role_name || row.before?.role_name || row.record_key}`
                : row.table_name === 'zb_guild_identity' ? 'bot identity' : 'server settings',
            actor: row.actor_role === 'bot_owner' ? 'ZiGBoT review'
                : row.actor_role === 'discord_admin' ? 'A server admin (/identity)'
                    : row.actor_user_id ? (names.get(row.actor_user_id) || 'dashboard user') : 'ZiGBoT (automatic)',
            fields: changedFields(row.before, row.after)
        }))
    });
});
