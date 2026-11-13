import { handler, json, HttpError } from '@/lib/http';
import { ownedWorkflow } from '@/lib/studio/workflowServer';
import { requireStudioUser } from '@/lib/studio/server';
import { getAutomationEntitlement, paywallBody } from '@/lib/studio/entitlementServer';
import runtime from '@/lib/studio/runtime';

export const dynamic = 'force-dynamic';

// POST: run the workflow for real (not the free simulator preview).
// Premium is validated on EVERY call, before anything else. Real execution
// needs an isolated runtime, which does not exist yet, so an entitled user
// gets 503 runtime_not_available (nothing runs on this server).
export const POST = handler(async (_request, { params }) => {
    const session = await requireStudioUser();
    const { workflow } = await ownedWorkflow(params, session);
    const entitlement = await getAutomationEntitlement(session);
    if (!entitlement.premium) throw new HttpError(402, 'Running automations is a Premium feature.', paywallBody());
    if (!workflow.active) throw new HttpError(409, 'Activate the workflow first.');
    const provider = runtime.getProvider();
    if (!provider.available) throw new HttpError(503, 'Live execution starts when Studio hosting is available. Use “Test in simulator” to preview runs meanwhile.', { code: 'runtime_not_available' });
    return json({ queued: false });
});
