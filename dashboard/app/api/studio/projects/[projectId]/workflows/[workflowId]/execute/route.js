import { handler, json, HttpError } from '@/lib/http';
import { createServiceClient } from '@/lib/supabase/server';
import { ownedWorkflow } from '@/lib/studio/workflowServer';
import { requireStudioUser } from '@/lib/studio/server';
import { getAutomationEntitlement, paywallBody } from '@/lib/studio/entitlementServer';
import runtime from '@/lib/studio/runtime';

export const dynamic = 'force-dynamic';

// POST: run the workflow live (not the free simulator preview).
// Premium is validated on EVERY call, before anything else. Studio has no
// hosting of its own (runtime.getProvider() is "not available"), so live
// runs happen on the owner's paired self-hosted runner: this queues a
// deploy, and the runner's bundle includes every ACTIVE workflow after the
// server re-checks Premium. Nothing runs on this server.
export const POST = handler(async (_request, { params }) => {
    const session = await requireStudioUser();
    const { ownerId, project, workflow } = await ownedWorkflow(params, session);
    const entitlement = await getAutomationEntitlement(session);
    if (!entitlement.premium) throw new HttpError(402, 'Running automations is a Premium feature.', paywallBody());
    if (!workflow.active) throw new HttpError(409, 'Activate the workflow first.');
    if (project.framework !== 'discordjs') throw new HttpError(422, 'Live workflows run in discord.js (JavaScript) projects. This project uses another framework.');

    const provider = runtime.getProvider();
    if (provider.available) throw new HttpError(503, 'Hosted execution is not wired up yet.', { code: 'runtime_not_available' });
    const db = createServiceClient();
    const { data: runners } = await db.from('studio_runners').select('id').eq('project_id', project.id).eq('owner_id', ownerId).eq('status', 'paired');
    if (!(runners || []).length) throw new HttpError(409, 'Add and pair a self-hosted runner on the Deployments page: active workflows run inside your bot there.', { code: 'no_runner' });
    const { error } = await db.from('studio_runner_commands').insert(runners.map((r) => ({ runner_id: r.id, project_id: project.id, owner_id: ownerId, action: 'deploy' })));
    if (error) throw new Error('Could not queue the deploy.');
    return json({ queued: runners.length, message: `Deploying to ${runners.length} runner(s). Active workflows start when your bot restarts.` });
});
