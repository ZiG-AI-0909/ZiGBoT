import { handler, json, readJson, HttpError } from '@/lib/http';
import workflows from '@/lib/studio/workflows';
import { ownedWorkflow } from '@/lib/studio/workflowServer';
import { requireStudioUser } from '@/lib/studio/server';
import ent from '@/lib/studio/entitlements';
import { createServiceClient } from '@/lib/supabase/server';
import { getAutomationEntitlement } from '@/lib/studio/entitlementServer';

export const dynamic = 'force-dynamic';

// GET: the workflow, its validation problems and its last 20 test runs.
export const GET = handler(async (_request, { params }) => {
    const session = await requireStudioUser();
    const { supabase, ownerId, workflow } = await ownedWorkflow(params, session);
    const { data: runs } = await supabase.from('studio_workflow_runs').select('id, ok, result, created_at').eq('workflow_id', workflow.id).eq('owner_id', ownerId).order('id', { ascending: false }).limit(20);
    const entitlement = await getAutomationEntitlement(session);
    return json({
        workflow: { id: workflow.id, name: workflow.name, graph: workflow.graph, updatedAt: workflow.updated_at, active: Boolean(workflow.active), state: ent.effectiveState(workflow, entitlement) },
        entitlement: { premium: entitlement.premium, source: entitlement.source, expiresAt: entitlement.expiresAt },
        problems: workflows.validateWorkflow(workflow.graph).problems,
        runs: (runs || []).map((r) => ({ id: r.id, ok: r.ok, error: r.result?.error || null, steps: r.result?.steps?.length || 0, createdAt: r.created_at }))
    });
});

// PUT { name?, graph }: drafts may be saved with problems; they are returned.
export const PUT = handler(async (request, { params }) => {
    const { supabase, ownerId, workflow } = await ownedWorkflow(params, await requireStudioUser());
    const body = await readJson(request, 300 * 1024);
    const patch = { updated_at: new Date().toISOString() };
    if (body?.name !== undefined) {
        const name = String(body.name).trim();
        if (!name || name.length > 60) throw new HttpError(422, 'Workflow names are 1-60 characters.');
        patch.name = name;
    }
    if (body?.graph !== undefined) {
        const parsed = workflows.parseGraph(body.graph);
        if (parsed.error) throw new HttpError(422, parsed.error);
        patch.graph = parsed.graph;
    }
    const { error } = await supabase.from('studio_workflows').update(patch).eq('id', workflow.id).eq('owner_id', ownerId);
    if (error) throw new Error(`Workflow save failed: ${error.message}`);
    const problems = workflows.validateWorkflow(patch.graph || workflow.graph).problems;
    // An active workflow that no longer validates goes back to draft (server-side write).
    let deactivated = false;
    if (workflow.active && problems.length) {
        const { error: offError } = await createServiceClient().from('studio_workflows').update({ active: false, activated_at: null }).eq('id', workflow.id).eq('owner_id', ownerId);
        deactivated = !offError;
    }
    return json({ saved: true, problems, deactivated });
});

export const DELETE = handler(async (_request, { params }) => {
    const { supabase, ownerId, workflow } = await ownedWorkflow(params, await requireStudioUser());
    const { error } = await supabase.from('studio_workflows').delete().eq('id', workflow.id).eq('owner_id', ownerId);
    if (error) throw new Error(`Workflow delete failed: ${error.message}`);
    return json({ deleted: true });
});
