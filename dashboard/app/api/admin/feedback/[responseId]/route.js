import { handler, json, readJson, HttpError } from '@/lib/http';
import { requireSuperAdmin, adminRateLimit, writeAdminAudit } from '@/lib/admin';
import { createServiceClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

const NOTE_MAX = 2000;

// PATCH { review_status?: 'new'|'reviewed', admin_note?: string|null, archived?: boolean }
// Super Admin only. Only the review fields change: the customer's answers
// are never edited, and responses are archived, never deleted.
export const PATCH = handler(async (request, { params }) => {
    const admin = await requireSuperAdmin();
    adminRateLimit(admin.discordId);
    const { responseId } = await params;
    if (!/^[0-9a-f-]{36}$/i.test(String(responseId || ''))) throw new HttpError(400, 'Invalid response.');
    const body = await readJson(request);
    const changes = {};
    if (body?.review_status !== undefined) {
        if (!['new', 'reviewed'].includes(body.review_status)) throw new HttpError(422, 'Review status must be new or reviewed.');
        changes.review_status = body.review_status;
        changes.reviewed_at = body.review_status === 'reviewed' ? new Date().toISOString() : null;
    }
    if (body?.admin_note !== undefined) {
        const note = body.admin_note === null ? '' : String(body.admin_note).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim();
        if (note.length > NOTE_MAX) throw new HttpError(422, `Notes can be at most ${NOTE_MAX} characters.`);
        changes.admin_note = note || null;
    }
    if (body?.archived !== undefined) {
        if (typeof body.archived !== 'boolean') throw new HttpError(422, 'archived must be true or false.');
        changes.archived_at = body.archived ? new Date().toISOString() : null;
    }
    if (Object.keys(changes).length === 0) throw new HttpError(400, 'Nothing to change.');

    const { data, error } = await createServiceClient().from('zb_premium_feedback')
        .update(changes).eq('id', responseId).select('id, review_status, reviewed_at, archived_at, admin_note');
    if (error) throw new Error(`Feedback update failed: ${error.message}`);
    if (!data || data.length === 0) throw new HttpError(404, 'That response does not exist.');
    await writeAdminAudit(admin, {
        action: 'feedback.update',
        targetType: 'feedback',
        targetId: responseId,
        // Which fields changed, never the note text itself.
        metadata: { fields: Object.keys(changes).filter((k) => k !== 'reviewed_at'), review_status: changes.review_status, archived: body?.archived }
    });
    return json({ response: data[0] });
});
