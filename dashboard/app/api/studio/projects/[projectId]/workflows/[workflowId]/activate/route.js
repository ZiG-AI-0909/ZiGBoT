import { handler, json, readJson, HttpError } from '@/lib/http';
import workflows from '@/lib/studio/workflows';
import { createServiceClient } from '@/lib/supabase/server';
import { ownedWorkflow } from '@/lib/studio/workflowServer';
import { requireStudioUser } from '@/lib/studio/server';
import { getAutomationEntitlement, paywallBody } from '@/lib/studio/entitlementServer';

export const dynamic = 'force-dynamic';

// POST { active: true | false }
// Deactivating is always allowed. Activating needs Premium, checked here on
// the server from stored data (never from the request), and a workflow with
// no validation problems. Only the server can write the activation columns.
export const POST = handler(async (request, { params }) => {
    const session = await requireStudioUser();
    const { ownerId, workflow } = await ownedWorkflow(params, session);
    const body = await readJson(request);
    if (typeof body?.active !== 'boolean') throw new HttpError(422, 'Send active: true or false.');
    const db = createServiceClient();

    if (!body.active) {
        const { error } = await db.from('studio_workflows').update({ active: false, activated_at: null }).eq('id', workflow.id).eq('owner_id', ownerId);
        if (error) throw new Error('Deactivation failed.');
        return json({ active: false, state: 'draft' });
    }

    const entitlement = await getAutomationEntitlement(session);
    if (!entitlement.premium) throw new HttpError(402, 'Activating automations is a Premium feature.', paywallBody());
    const { problems } = workflows.validateWorkflow(workflow.graph);
    if (problems.length) throw new HttpError(422, 'Fix the workflow before activating it.', { problems });
    const { error } = await db.from('studio_workflows').update({ active: true, activated_at: new Date().toISOString() }).eq('id', workflow.id).eq('owner_id', ownerId);
    if (error) throw new Error('Activation failed.');
    return json({ active: true, state: 'active', entitlement: { source: entitlement.source, expiresAt: entitlement.expiresAt }, runtime: { available: false, message: 'It runs live inside your bot on your self-hosted runner from the next deploy (press "Run live now" or Deploy).' } });
});
