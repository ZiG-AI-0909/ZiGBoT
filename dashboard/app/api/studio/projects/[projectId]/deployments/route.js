import { handler, json, readJson, HttpError } from '@/lib/http';
import runtime from '@/lib/studio/runtime';
import { requireStudioUser, getOwnedProject } from '@/lib/studio/server';

export const dynamic = 'force-dynamic';

// GET: hosting availability and this project's deployment history.
export const GET = handler(async (_request, { params }) => {
    const { projectId } = await params;
    const { supabase, ownerId } = await requireStudioUser();
    const project = await getOwnedProject(supabase, ownerId, projectId);
    const provider = runtime.getProvider();
    const { data, error } = await supabase.from('studio_deployments').select('id, version, status, provider, error, manifest, source_version, created_at').eq('project_id', project.id).eq('owner_id', ownerId).order('version', { ascending: false }).limit(runtime.HISTORY);
    return json({
        hosting: { available: provider.available, provider: provider.name, message: provider.available ? null : 'Hosting coming soon.' },
        deployments: error ? [] : (data || []).map(runtime.publicDeployment)
    });
});

// POST { action: deploy | start | stop | restart | rollback }: refused while
// no runtime provider exists. Customer code is never run on this server.
export const POST = handler(async (request, { params }) => {
    const { projectId } = await params;
    const { supabase, ownerId } = await requireStudioUser();
    await getOwnedProject(supabase, ownerId, projectId);
    const body = await readJson(request);
    if (!['deploy', 'start', 'stop', 'restart', 'rollback'].includes(body?.action)) throw new HttpError(422, 'Unknown action.');
    const provider = runtime.getProvider();
    if (!provider.available) throw new HttpError(503, new runtime.RuntimeNotAvailable().message, { code: 'runtime_not_available' });
    throw new HttpError(503, 'Hosting is not configured on this server.');
});
