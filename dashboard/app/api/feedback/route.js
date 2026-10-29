import { handler, json, readJson, HttpError } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import purchases from '@/lib/shared/purchases';
import { supabaseRepo } from '@/lib/feedback';

export const dynamic = 'force-dynamic';

// First-purchase Premium feedback for the SIGNED-IN user only. The user id
// comes from the verified Supabase session; the purchase must be theirs.

function asHttp(error) {
    if (error instanceof purchases.FeedbackError) return new HttpError(error.status, error.message, error.extra);
    return error;
}

// GET: { pending: { purchaseId, planPeriod, planLabel, snoozedUntil } | null }
export const GET = handler(async () => {
    const { user } = await requireUser();
    try {
        return json({ pending: await purchases.loadPendingFeedback({ repo: supabaseRepo(), userId: user.id }) });
    } catch (error) {
        // The form is optional: a storage problem must never break the dashboard.
        console.error('[feedback] pending lookup failed:', error?.message || error);
        return json({ pending: null });
    }
});

// POST { purchaseId, answers }: submit once.
export const POST = handler(async (request) => {
    const { user } = await requireUser();
    const body = await readJson(request);
    try {
        return json(await purchases.submitFeedback({ repo: supabaseRepo(), userId: user.id, purchaseId: body?.purchaseId, input: body?.answers }));
    } catch (error) {
        throw asHttp(error);
    }
});
