import { handler, HttpError } from '@/lib/http';
import { requireStudioUser, getOwnedProject } from '@/lib/studio/server';

export const dynamic = 'force-dynamic';

// The .zip download is switched off (owner's decision, 2026-11-13): project
// code leaves Studio only through a paired self-hosted runner (Deployments).
// Kept as an owner-checked route that answers 410, so old links explain it.
export const GET = handler(async (_request, { params }) => {
    const { projectId } = await params;
    const { supabase, ownerId } = await requireStudioUser();
    await getOwnedProject(supabase, ownerId, projectId);
    throw new HttpError(410, 'Project downloads are switched off. Run your bot on your own machine with a self-hosted runner (Deployments page).', { code: 'export_disabled' });
});
