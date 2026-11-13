import { handler, json, readJson, HttpError } from '@/lib/http';
import workflows from '@/lib/studio/workflows';
import { requireStudioUser, getOwnedProject } from '@/lib/studio/server';

export const dynamic = 'force-dynamic';

// GET: the project's workflows + the block catalog for the palette.
export const GET = handler(async (_request, { params }) => {
    const { projectId } = await params;
    const { supabase, ownerId } = await requireStudioUser();
    const project = await getOwnedProject(supabase, ownerId, projectId);
    const { data, error } = await supabase.from('studio_workflows').select('id, name, updated_at').eq('project_id', project.id).eq('owner_id', ownerId).order('updated_at', { ascending: false });
    if (error) throw new HttpError(503, 'Workflow storage is not set up yet: run the newest files in supabase/migrations.');
    return json({ workflows: (data || []).map((w) => ({ id: w.id, name: w.name, updatedAt: w.updated_at })), catalog: workflows.catalog(), limits: workflows.LIMITS, framework: project.framework });
});

// POST { name, graph? }
export const POST = handler(async (request, { params }) => {
    const { projectId } = await params;
    const { supabase, ownerId } = await requireStudioUser();
    const project = await getOwnedProject(supabase, ownerId, projectId);
    const body = await readJson(request, 300 * 1024);
    const name = String(body?.name ?? '').trim();
    if (!name || name.length > 60) throw new HttpError(422, 'Workflow names are 1-60 characters.', { fieldErrors: { name: 'Invalid name.' } });
    const parsed = workflows.parseGraph(body?.graph ?? { nodes: [], edges: [] });
    if (parsed.error) throw new HttpError(422, parsed.error);
    const { data, error } = await supabase.from('studio_workflows').insert({ project_id: project.id, owner_id: ownerId, name, graph: parsed.graph }).select('id, name').single();
    if (error) throw /studio_workflow_limit/.test(error.message) ? new HttpError(403, `At most ${workflows.LIMITS.workflowsPerProject} workflows per project.`) : new Error(`Workflow create failed: ${error.message}`);
    return json({ workflow: data }, 201);
});
