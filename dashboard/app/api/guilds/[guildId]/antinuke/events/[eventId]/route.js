import shared from '@/lib/shared';
import { handler, json, readJson, HttpError } from '@/lib/http';
import { requireGuildAdmin } from '@/lib/auth';
import { createServiceClient } from '@/lib/supabase/server';

const { INCIDENT_STATUSES } = shared;

export const dynamic = 'force-dynamic';

// PATCH { status: open | acknowledged | resolved } — mark an incident. The
// update is pinned to BOTH the incident id and the verified guild id, so an
// admin of one server can never change another server's incident.
export const PATCH = handler(async (request, { params }) => {
    const { guildId, eventId } = await params;
    const { guild } = await requireGuildAdmin(guildId);
    if (!/^\d{1,18}$/.test(String(eventId || ''))) throw new HttpError(400, 'Invalid incident.');
    const body = await readJson(request);
    if (!INCIDENT_STATUSES.includes(body?.status)) throw new HttpError(422, 'Pick open, acknowledged or resolved.');
    const { data, error } = await createServiceClient()
        .from('zb_security_events')
        .update({ status: body.status, updated_at: new Date().toISOString() })
        .eq('id', Number(eventId))
        .eq('guild_id', String(guild.id))
        .select('id, status');
    if (error) throw new Error(`Incident update failed: ${error.message}`);
    if (!data || data.length === 0) throw new HttpError(404, 'That incident does not exist in this server.');
    return json({ event: data[0] });
});
