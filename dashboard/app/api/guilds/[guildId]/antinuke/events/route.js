import shared from '@/lib/shared';
import { handler, json, HttpError } from '@/lib/http';
import { requireGuildAdmin } from '@/lib/auth';
import { createServiceClient } from '@/lib/supabase/server';

const { ANTINUKE_SEVERITIES, INCIDENT_STATUSES, ANTINUKE_RULES } = shared;

export const dynamic = 'force-dynamic';

const PAGE = 50;
const EXPORT_MAX = 1000;
const COLUMNS = 'id, rule, severity, actor_id, actor_is_bot, target_ids, resource_count, occurrences, reason, evidence, containment_status, containment_actions, alert_status, status, created_at, updated_at';

// GET ?severity=&status=&rule=&actor=&before=<id>[&export=1]
// Incident history for THIS server only (pinned to the verified guild id).
export const GET = handler(async (request, { params }) => {
    const { guildId } = await params;
    const { guild } = await requireGuildAdmin(guildId);
    const url = new URL(request.url);
    const severity = url.searchParams.get('severity');
    const status = url.searchParams.get('status');
    const rule = url.searchParams.get('rule');
    const actor = url.searchParams.get('actor');
    const before = url.searchParams.get('before');
    const exporting = url.searchParams.get('export') === '1';

    let query = createServiceClient().from('zb_security_events').select(COLUMNS).eq('guild_id', String(guild.id));
    if (severity) {
        if (!ANTINUKE_SEVERITIES.includes(severity)) throw new HttpError(400, 'Unknown severity.');
        query = query.eq('severity', severity);
    }
    if (status) {
        if (!INCIDENT_STATUSES.includes(status)) throw new HttpError(400, 'Unknown status.');
        query = query.eq('status', status);
    }
    if (rule) {
        if (!ANTINUKE_RULES[rule]) throw new HttpError(400, 'Unknown incident type.');
        query = query.eq('rule', rule);
    }
    if (actor) {
        if (!/^\d{17,20}$/.test(actor)) throw new HttpError(400, 'Search by a Discord user ID (17-20 digits).');
        query = query.eq('actor_id', actor);
    }
    if (before) {
        if (!/^\d{1,18}$/.test(before)) throw new HttpError(400, 'Invalid page.');
        query = query.lt('id', Number(before));
    }
    const { data, error } = await query.order('id', { ascending: false }).limit(exporting ? EXPORT_MAX : PAGE);
    if (error) throw new Error(`Incident read failed: ${error.message}`);
    const events = (data || []).map((row) => ({ ...row, title: ANTINUKE_RULES[row.rule]?.title || row.rule }));
    if (exporting) {
        return new Response(JSON.stringify({ guild_id: String(guild.id), exported_at: new Date().toISOString(), events }, null, 2), {
            headers: {
                'Content-Type': 'application/json; charset=utf-8',
                'Content-Disposition': `attachment; filename="zigbot-security-${guild.id}.json"`,
                'Cache-Control': 'no-store'
            }
        });
    }
    return json({ events, nextBefore: events.length === PAGE ? events[events.length - 1].id : null });
});
