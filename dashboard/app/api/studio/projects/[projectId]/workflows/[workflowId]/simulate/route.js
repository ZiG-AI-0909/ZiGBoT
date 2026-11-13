import { handler, json, readJson, HttpError } from '@/lib/http';
import workflows from '@/lib/studio/workflows';
import { ownedWorkflow } from '@/lib/studio/workflowServer';
import market from '@/lib/studio/marketplace';
import { requireStudioUser, getPlan } from '@/lib/studio/server';

export const dynamic = 'force-dynamic';

// POST { triggerId?, event? }: run the SAVED workflow in the simulator
// (mocked Discord, no network, no AI, bounded loops / steps / time).
// At most LIMITS.runsPerDay test runs per user per day; 20 kept per workflow.
export const POST = handler(async (request, { params }) => {
    const { supabase, ownerId, project, workflow } = await ownedWorkflow(params, await requireStudioUser());
    const since = new Date(Date.now() - 86400000).toISOString();
    const { count } = await supabase.from('studio_workflow_runs').select('id', { count: 'exact', head: true }).eq('owner_id', ownerId).gte('created_at', since);
    // Plan limit (Free = workflows.LIMITS.runsPerDay = 200).
    const perDay = market.limitsFor(await getPlan(supabase, ownerId)).simulatorRunsPerDay;
    if ((count || 0) >= perDay) throw new HttpError(429, `You can test ${perDay} times per day on your plan. Try again tomorrow.`);
    const body = await readJson(request, 16 * 1024);
    const result = workflows.simulate(workflow.graph, { triggerId: body?.triggerId, event: body?.event });
    const stored = { ok: result.ok, error: result.error || null, steps: result.steps.slice(0, 300), actions: result.actions.slice(0, 200) };
    await supabase.from('studio_workflow_runs').insert({ workflow_id: workflow.id, project_id: project.id, owner_id: ownerId, ok: result.ok, result: stored });
    return json({ result });
});
