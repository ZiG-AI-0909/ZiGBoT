import shared from '@/lib/shared';
import { handler, json, readJson, HttpError } from '@/lib/http';
import { requireSuperAdmin, adminRateLimit, writeAdminAudit } from '@/lib/admin';
import { createServiceClient } from '@/lib/supabase/server';

const { INCIDENT_STATUSES } = shared;

export const dynamic = 'force-dynamic';

// PATCH { status: open | acknowledged | resolved } — Super Admin triage of
// an Anti-Nuke incident in any server. Recorded in the admin audit log.
export const PATCH = handler(async (request, { params }) => {
    const admin = await requireSuperAdmin();
    adminRateLimit(admin.discordId);
    const { eventId } = await params;
    if (!/^\d{1,18}$/.test(String(eventId || ''))) throw new HttpError(400, 'Invalid incident.');
    const body = await readJson(request);
    if (!INCIDENT_STATUSES.includes(body?.status)) throw new HttpError(422, 'Pick open, acknowledged or resolved.');
    const { data, error } = await createServiceClient().from('zb_security_events')
        .update({ status: body.status, updated_at: new Date().toISOString() })
        .eq('id', Number(eventId))
        .select('id, guild_id, status');
    if (error) throw new Error(`Incident update failed: ${error.message}`);
    if (!data || data.length === 0) throw new HttpError(404, 'That incident does not exist.');
    await writeAdminAudit(admin, { action: 'security.incident_status', targetType: 'incident', targetId: eventId, metadata: { guild_id: data[0].guild_id, status: body.status } });
    return json({ event: data[0] });
});
