import shared from '@/lib/shared';
import { handler, json, readJson, HttpError } from '@/lib/http';
import { requireGuildAdmin } from '@/lib/auth';
import { loadPlan, recordCheckout } from '@/lib/billing';
import { createSubscription } from '@/lib/razorpay';
import { env } from '@/lib/env';

const { PREMIUM_PERIODS } = shared;

export const dynamic = 'force-dynamic';

// POST { period }: start a Razorpay subscription for THIS verified server.
// Returns what the Standard Checkout modal needs (public key id +
// subscription id) plus the hosted payment link as a fallback. Nothing is
// unlocked here — only a charged subscription fetched back from Razorpay
// (verify / sync / webhook) does that. The price comes from the Razorpay plan,
// never from the browser.
export const POST = handler(async (request, { params }) => {
    const { guildId } = await params;
    const { guild, user } = await requireGuildAdmin(guildId);
    if (!env.billingEnabled) throw new HttpError(503, 'Premium checkout is not set up yet.');

    const body = await readJson(request);
    const period = body?.period;
    if (!PREMIUM_PERIODS.includes(period)) throw new HttpError(422, 'Choose monthly or yearly.');

    const plan = await loadPlan(guild);
    if (plan.isHome) throw new HttpError(409, 'You own this server, so it already has every Premium feature for free.');
    if (plan.status === 'active' && !plan.cancelAtPeriodEnd) throw new HttpError(409, 'This server already has an active Premium subscription.');

    const { subscription, url } = await createSubscription({ planId: env.razorpayPlans[period], period, guildId: guild.id });
    await recordCheckout(subscription, { guildId: guild.id, purchasedBy: user.id });
    // The key ID is public by design (Checkout.js needs it); the KEY SECRET never leaves the server.
    return json({ keyId: env.razorpayKeyId, subscriptionId: subscription.id, url });
});
