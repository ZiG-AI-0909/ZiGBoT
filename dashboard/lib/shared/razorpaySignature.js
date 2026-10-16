/**
 * Razorpay webhook signature check: HMAC-SHA256 of the RAW request body with
 * the webhook secret, hex-encoded, compared in constant time.
 *
 * Kept separate from shared/index.js on purpose (it needs node:crypto and is
 * only ever used server-side), but CommonJS so the test suite can run it.
 */
const crypto = require('node:crypto');

function verifyRazorpaySignature(rawBody, signature, secret) {
    if (!secret || typeof rawBody !== 'string') return false;
    if (!signature || typeof signature !== 'string' || !/^[a-f0-9]{64}$/i.test(signature)) return false;
    const expected = crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
    return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature.toLowerCase(), 'hex'));
}

/**
 * Standard Checkout success signature for a SUBSCRIPTION payment:
 * HMAC-SHA256(payment_id + "|" + subscription_id) with the API KEY SECRET.
 * (For one-time orders Razorpay signs order_id + "|" + payment_id instead.)
 */
function verifyRazorpaySubscriptionPayment({ paymentId, subscriptionId, signature }, secret) {
    if (!/^pay_[A-Za-z0-9]{8,40}$/.test(String(paymentId || ''))) return false;
    if (!/^sub_[A-Za-z0-9]{8,40}$/.test(String(subscriptionId || ''))) return false;
    return verifyRazorpaySignature(`${paymentId}|${subscriptionId}`, signature, secret);
}

module.exports = { verifyRazorpaySignature, verifyRazorpaySubscriptionPayment };
