import { NextResponse } from 'next/server';
import { syncSubscription } from '@/lib/billing';
import { getSubscription, verifyWebhookSignature } from '@/lib/razorpay';
import { env } from '@/lib/env';
import { guildPremium, revertIdentity } from '@/lib/identity';

export const dynamic = 'force-dynamic';

// Razorpay -> us. Not wrapped in the same-origin handler (Razorpay is the
// caller); instead every delivery must carry a valid HMAC signature made
// with OUR webhook secret over the raw body. Even then the event body is
// not trusted: the subscription is re-fetched from Razorpay and only that
// is stored.
const reply = (status, body = {}) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

// Custom bot identity: a server that is no longer Premium goes back to the
// default ZiGBoT profile right away. Best effort: the bot's periodic sync is
// the safety net, so a failure here never makes Razorpay retry.
async function revertLapsedIdentity(guildId) {
    if (!env.customIdentityEnabled || !/^\d{17,20}$/.test(String(guildId || ''))) return;
    try {
        const { guild, premium } = await guildPremium(guildId);
        if (guild && !premium) await revertIdentity(guildId, 'premium_lapsed');
    } catch (error) {
        console.error('[billing webhook] identity revert failed:', error?.status || error?.message);
    }
}

export async function POST(request) {
    if (!env.webhookEnabled) return reply(503, { error: 'billing webhook disabled' });

    const raw = await request.text();
    if (raw.length > 256 * 1024) return reply(413);
    if (!verifyWebhookSignature(raw, request.headers.get('x-razorpay-signature'))) {
        return reply(401, { error: 'signature verification failed' });
    }

    let event;
    try {
        event = JSON.parse(raw);
    } catch {
        return reply(400);
    }

    try {
        const subscriptionId = String(event?.event || '').startsWith('subscription.')
            ? event?.payload?.subscription?.entity?.id
            : null;
        if (!subscriptionId) return reply(200, { ignored: true });

        const subscription = await getSubscription(subscriptionId);
        if (subscription) {
            await syncSubscription(subscription);
            await revertLapsedIdentity(subscription?.notes?.guild_id);
        }
        return reply(200, { ok: true });
    } catch (error) {
        // Non-2xx makes Razorpay retry later, which is what we want on a transient failure.
        console.error('[billing webhook]', error?.message || error);
        return reply(500);
    }
}
