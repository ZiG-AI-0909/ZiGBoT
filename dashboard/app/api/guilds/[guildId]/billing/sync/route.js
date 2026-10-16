import { handler, json, HttpError } from '@/lib/http';
import { requireGuildAdmin } from '@/lib/auth';
import { getStoredSubscription, loadPlan, syncSubscription } from '@/lib/billing';
import { getSubscription } from '@/lib/razorpay';
import { env } from '@/lib/env';

export const dynamic = 'force-dynamic';

// POST: refresh THIS server's plan straight from Razorpay (used while the
// buyer pays on Razorpay's page, so Premium appears without waiting for the
// webhook). Takes no ids from the browser: only the subscriptions this
// server already started are looked up, and each must belong to this server.
export const POST = handler(async (_request, { params }) => {
    const { guildId } = await params;
    const { guild } = await requireGuildAdmin(guildId);
    if (!env.billingEnabled) throw new HttpError(503, 'Premium checkout is not set up yet.');

    const stored = await getStoredSubscription(guild.id);
    const ids = [...new Set([stored?.pending_subscription_id, stored?.subscription_id].filter(Boolean))];
    for (const id of ids) {
        const subscription = await getSubscription(id);
        if (subscription && String(subscription.notes?.guild_id) === String(guild.id)) {
            await syncSubscription(subscription, { expectedGuildId: guild.id });
        }
    }
    return json({ plan: await loadPlan(guild) });
});
