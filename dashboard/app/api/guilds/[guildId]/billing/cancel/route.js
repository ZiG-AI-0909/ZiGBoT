import { handler, json, HttpError } from '@/lib/http';
import { requireGuildAdmin } from '@/lib/auth';
import { getStoredSubscription, loadPlan, syncSubscription } from '@/lib/billing';
import { cancelAtPeriodEnd, getSubscription } from '@/lib/razorpay';
import { env } from '@/lib/env';

export const dynamic = 'force-dynamic';

// POST: stop THIS server's renewals. Premium stays until the end of the
// period already paid for; Razorpay then marks the subscription cancelled.
export const POST = handler(async (_request, { params }) => {
    const { guildId } = await params;
    const { guild } = await requireGuildAdmin(guildId);
    if (!env.billingEnabled) throw new HttpError(503, 'Premium checkout is not set up yet.');

    const stored = await getStoredSubscription(guild.id);
    if (!stored || stored.status !== 'active' || stored.cancel_at_period_end) {
        throw new HttpError(409, 'This server has no renewing subscription to cancel.');
    }

    await cancelAtPeriodEnd(stored.subscription_id);
    const fresh = await getSubscription(stored.subscription_id);
    if (fresh) await syncSubscription(fresh, { expectedGuildId: guild.id, cancelAtPeriodEnd: true });
    return json({ plan: await loadPlan(guild) });
});
