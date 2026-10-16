import { handler, json, readJson, HttpError } from '@/lib/http';
import { requireGuildAdmin } from '@/lib/auth';
import { getStoredSubscription, loadPlan, syncSubscription } from '@/lib/billing';
import { getSubscription, verifyCheckoutPayment } from '@/lib/razorpay';
import { env } from '@/lib/env';

export const dynamic = 'force-dynamic';

// POST { razorpay_payment_id, razorpay_subscription_id, razorpay_signature }:
// the Standard Checkout success callback for THIS server.
//   1. All three fields are required (400 otherwise).
//   2. The subscription must be one this server started (no reusing another
//      server's payment).
//   3. HMAC-SHA256(payment_id + "|" + subscription_id, KEY_SECRET) must match
//      (400 otherwise; nothing is marked as paid).
// Even then the plan comes from Razorpay itself: the subscription is
// re-fetched and stored, and Premium switches on only when Razorpay says it
// is active.
export const POST = handler(async (request, { params }) => {
    const { guildId } = await params;
    const { guild, user } = await requireGuildAdmin(guildId);
    if (!env.billingEnabled) throw new HttpError(503, 'Premium checkout is not set up yet.');

    const body = await readJson(request);
    const paymentId = typeof body?.razorpay_payment_id === 'string' ? body.razorpay_payment_id : '';
    const subscriptionId = typeof body?.razorpay_subscription_id === 'string' ? body.razorpay_subscription_id : '';
    const signature = typeof body?.razorpay_signature === 'string' ? body.razorpay_signature : '';
    if (!paymentId || !subscriptionId || !signature) throw new HttpError(400, 'Missing payment details from Razorpay.');

    const stored = await getStoredSubscription(guild.id);
    if (![stored?.pending_subscription_id, stored?.subscription_id].includes(subscriptionId)) {
        throw new HttpError(400, 'That payment does not belong to a checkout started for this server.');
    }
    if (!verifyCheckoutPayment({ paymentId, subscriptionId, signature })) {
        throw new HttpError(400, 'Payment signature mismatch. Nothing was activated; if you were charged, contact us.');
    }

    const subscription = await getSubscription(subscriptionId);
    if (!subscription || String(subscription.notes?.guild_id) !== String(guild.id)) {
        throw new HttpError(400, 'Razorpay does not confirm that subscription for this server.');
    }
    await syncSubscription(subscription, { expectedGuildId: guild.id, purchasedBy: user.id });
    return json({ verified: true, plan: await loadPlan(guild) });
});
