import 'server-only';
import { requireUser } from '@/lib/auth';
import { HttpError } from '@/lib/http';
import studio from '@/lib/studio/projects';

/**
 * Studio data access. The user's own Supabase client is used, so row-level
 * security limits every query to their rows; every query ALSO filters by
 * owner_id = the verified session user (defence in depth against IDOR).
 * Uses the existing Discord login (lib/auth.js); there is no second auth.
 */
export async function requireStudioUser() {
    const current = await requireUser();
    return { ...current, ownerId: current.user.id };
}

export async function getPlan(supabase, ownerId) {
    const { data } = await supabase.from('studio_accounts').select('plan').eq('user_id', ownerId).maybeSingle();
    return data?.plan && studio.PLANS[data.plan] ? data.plan : 'free';
}

export function assertProjectId(projectId) {
    if (!studio.UUID.test(String(projectId || ''))) throw new HttpError(404, 'Project not found.');
    return String(projectId);
}

/** The project, only if the session user owns it; 404 otherwise (no existence leak). */
export async function getOwnedProject(supabase, ownerId, projectId) {
    const id = assertProjectId(projectId);
    const { data, error } = await supabase.from('studio_projects').select('*').eq('id', id).eq('owner_id', ownerId).maybeSingle();
    if (error) throw new Error(`Project read failed: ${error.message}`);
    if (!data || data.owner_id !== ownerId) throw new HttpError(404, 'Project not found.');
    return data;
}

export function mapWriteError(error, plan) {
    if (studio.isLimitError(error)) return new HttpError(403, `Your ${studio.PLANS[plan].label} plan allows ${studio.planLimit(plan)} projects. Delete one to make room.`, { code: 'plan_limit' });
    if (studio.isDuplicateNameError(error)) return new HttpError(409, 'You already have a project with that name.', { fieldErrors: { name: 'Pick another name.' } });
    if (/relation|schema cache|does not exist/i.test(error?.message || '')) return new HttpError(503, 'Studio storage is not set up yet: run the newest files in supabase/migrations.');
    return new Error(`Project write failed: ${error?.message}`);
}
