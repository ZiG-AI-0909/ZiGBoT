import { handler, json, readJson, HttpError } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import purchases from '@/lib/shared/purchases';
import { supabaseRepo } from '@/lib/feedback';

export const dynamic = 'force-dynamic';

// POST { purchaseId }: "Remind Me Later" — the form stays pending and comes
// back on a dashboard visit after a day. Only the buyer can snooze it.
export const POST = handler(async (request) => {
    const { user } = await requireUser();
    const body = await readJson(request);
    try {
        return json(await purchases.remindLater({ repo: supabaseRepo(), userId: user.id, purchaseId: body?.purchaseId }));
    } catch (error) {
        if (error instanceof purchases.FeedbackError) throw new HttpError(error.status, error.message, error.extra);
        throw error;
    }
});
