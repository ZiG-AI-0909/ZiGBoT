import { handler, json, readJson, HttpError } from '@/lib/http';
import checks from '@/lib/studio/checks';
import { requireStudioUser, getOwnedProject } from '@/lib/studio/server';

export const dynamic = 'force-dynamic';

// GET: which checks exist, and which are not available (they need a sandbox).
export const GET = handler(async () => json({
    checks: Object.entries(checks.CHECKS).map(([id, c]) => ({ id, label: c.label })),
    notAvailable: checks.NOT_AVAILABLE
}));

// POST { check: 'structure' | 'syntax' | 'lint' }: STATIC analysis only.
// The project's code is parsed, never executed; there is no shell.
export const POST = handler(async (request, { params }) => {
    const { projectId } = await params;
    const { supabase, ownerId } = await requireStudioUser();
    const project = await getOwnedProject(supabase, ownerId, projectId);
    const body = await readJson(request);
    if (!checks.CHECKS[body?.check]) throw new HttpError(422, 'Pick one of the available checks.');
    const { data, error } = await supabase.from('studio_project_files').select('path, content').eq('project_id', project.id).eq('owner_id', ownerId).limit(1000);
    if (error) throw new Error(`File read failed: ${error.message}`);
    return json({ result: checks.runCheck(body.check, data || [], project.framework) });
});
