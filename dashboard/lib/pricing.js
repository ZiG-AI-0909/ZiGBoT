/**
 * Premium price display helpers. The real prices live in the Razorpay plans
 * (RAZORPAY_PLAN_MONTHLY / _YEARLY); PREMIUM_PRICE_MONTHLY / _YEARLY are the
 * labels shown to people (e.g. "₹599/month", "₹3,999/year"). The yearly
 * saving is computed from those labels, so it can never drift from them;
 * if a label has no readable amount, no saving is claimed.
 * CommonJS, so the root tests can load it.
 */

/** First amount in a label: "₹3,999/year" → 3999. null when there is none. */
function amountOf(label) {
    const m = String(label ?? '').replace(/,/g, '').match(/(\d+(?:\.\d+)?)/);
    return m ? Number(m[1]) : null;
}

/** Currency symbol/code before the amount ("₹", "$", "INR"), or ''. */
function currencyOf(label) {
    const m = String(label ?? '').match(/^\s*([^\d\s]+)\s*\d/);
    return m ? m[1] : '';
}

/**
 * How much yearly saves against 12 monthly payments:
 * { amount, percent, months, text } or null when it does not save anything.
 */
function yearlySavings({ monthly, yearly } = {}) {
    const m = amountOf(monthly); const y = amountOf(yearly);
    if (!m || !y || y >= m * 12) return null;
    const amount = Math.round(m * 12 - y);
    const percent = Math.floor(((m * 12 - y) / (m * 12)) * 100);
    const months = Math.floor((m * 12 - y) / m);
    const cur = currencyOf(yearly) || currencyOf(monthly);
    return { amount, percent, months, text: `Save ${cur}${amount.toLocaleString('en-IN')} (${percent}%) a year` };
}

module.exports = { amountOf, currencyOf, yearlySavings };
