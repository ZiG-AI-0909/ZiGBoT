import 'server-only';
import { env } from './env';
import { verifyRazorpaySignature, verifyRazorpaySubscriptionPayment } from './shared/razorpaySignature';

/**
 * Minimal Razorpay REST client (Subscriptions + webhook signatures).
 * Server-side only: the key secret never reaches a browser, and no Razorpay
 * script runs on our pages — buyers pay on Razorpay's hosted subscription
 * page (UPI Autopay, cards, netbanking; international cards when enabled on
 * the Razorpay account).
 */
const API = 'https://api.razorpay.com/v1';

export class RazorpayError extends Error {
    constructor(message, status, publicMessage = null) {
        super(message);
        this.status = status;
        // Shown to the admin by the route handler; never contains provider internals.
        if (publicMessage) this.publicMessage = publicMessage;
    }
}

// Billing cycles before a subscription completes (Razorpay requires a count):
// 5 years either way. The buyer can cancel any time, and resubscribe after.
const TOTAL_COUNT = { monthly: 60, yearly: 5 };
const SUBSCRIPTION_ID = /^sub_[A-Za-z0-9]{8,40}$/;

async function call(path, { method = 'GET', body } = {}) {
    const basic = Buffer.from(`${env.razorpayKeyId}:${env.razorpayKeySecret}`).toString('base64');
    const response = await fetch(`${API}${path}`, {
        method,
        headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: 'no-store'
    });
    if (response.status === 404) return null;
    if (!response.ok) {
        // Razorpay error descriptions are safe to log (no secrets), but keep them out of user responses.
        const detail = await response.json().catch(() => ({}));
        const logMessage = `Razorpay ${method} ${path.split('?')[0]} failed (${response.status}): ${detail?.error?.description || 'unknown error'}`;
        // Our API keys rejected: a server configuration problem, not the admin's
        // login, so never surface it as 401 (which the dashboard treats as "sign in again").
        if (response.status === 401) throw new RazorpayError(logMessage, 502, 'Payments are misconfigured on our side (Razorpay rejected the API keys). Please try again later.');
        throw new RazorpayError(logMessage, 502, 'Razorpay could not process that right now. Please try again in a moment.');
    }
    return response.json();
}

/** Create a subscription for one server; returns the entity and Razorpay's hosted payment link. */
export async function createSubscription({ planId, period, guildId }) {
    const subscription = await call('/subscriptions', {
        method: 'POST',
        body: {
            plan_id: planId,
            total_count: TOTAL_COUNT[period],
            customer_notify: 1,
            // Ties the payment to exactly one server; verified again on every sync.
            notes: { guild_id: String(guildId) }
        }
    });
    const url = subscription?.short_url;
    if (!SUBSCRIPTION_ID.test(String(subscription?.id || '')) || !url || !url.startsWith('https://')) {
        throw new RazorpayError('Razorpay did not return a payment link.', 502);
    }
    return { subscription, url };
}

/** The subscription as Razorpay currently sees it (the only source of truth), or null. */
export function getSubscription(subscriptionId) {
    if (!SUBSCRIPTION_ID.test(String(subscriptionId || ''))) return Promise.resolve(null);
    return call(`/subscriptions/${subscriptionId}`);
}

/** Stop renewals at the end of the current paid cycle (Premium stays until then). */
export async function cancelAtPeriodEnd(subscriptionId) {
    if (!SUBSCRIPTION_ID.test(String(subscriptionId || ''))) throw new RazorpayError('Invalid subscription id.', 400);
    return call(`/subscriptions/${subscriptionId}/cancel`, { method: 'POST', body: { cancel_at_cycle_end: 1 } });
}

/** Razorpay signs each webhook delivery with our webhook secret (see shared/razorpaySignature.js). */
export function verifyWebhookSignature(rawBody, signature) {
    return verifyRazorpaySignature(rawBody, signature, env.razorpayWebhookSecret);
}

/** The Checkout.js success callback's signature, checked with our KEY SECRET (server-side only). */
export function verifyCheckoutPayment({ paymentId, subscriptionId, signature }) {
    return verifyRazorpaySubscriptionPayment({ paymentId, subscriptionId, signature }, env.razorpayKeySecret);
}
