/**
 * Verified Premium purchases and the first-purchase feedback flow. Pure
 * logic over a small injected repository (lib/feedback.js plugs in Supabase;
 * tests plug in memory), so the rules are testable and storage-agnostic.
 *
 * Rules:
 *  - A purchase is recorded only for a subscription Razorpay itself reports
 *    as ACTIVE, once per subscription (renewals are not new purchases).
 *  - The plan comes from the subscription's Razorpay plan id; the amount
 *    from the Razorpay plan. Nothing comes from the browser.
 *  - A buyer's first-ever purchase gets the feedback form; any later one
 *    (e.g. an upgrade from ₹399 to ₹3,999) does not. The database's unique
 *    index settles a race between two first purchases.
 *  - Only the buyer can see, submit or snooze their form; one response per
 *    purchase.
 */
const { validateFeedback, planLabel, FEEDBACK_REMIND_LATER_HOURS } = require('./feedback');

class FeedbackError extends Error {
    constructor(status, message, extra = {}) {
        super(message);
        this.status = status;
        this.extra = extra;
    }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUnique = (error, name = '') => error?.code === '23505' && (!name || String(error.message || '').includes(name));

/** The plan period a Razorpay subscription is for, from OUR configured plan ids. */
function planPeriodOf(subscription, plans) {
    if (!subscription?.plan_id) return null;
    if (plans?.monthly && subscription.plan_id === plans.monthly) return 'monthly';
    if (plans?.yearly && subscription.plan_id === plans.yearly) return 'yearly';
    return null;
}

/**
 * Record a verified purchase. Returns the stored purchase, or null when
 * there is nothing to record (not active, unknown plan, no server).
 * fetchPlanAmount(planId) -> { amount_paise, currency } from Razorpay.
 */
async function recordVerifiedPurchase({ repo, subscription, plans, fetchPlanAmount, now = Date.now() }) {
    if (subscription?.status !== 'active') return null;
    const subscriptionId = String(subscription.id || '');
    const guildId = String(subscription.notes?.guild_id || '');
    const period = planPeriodOf(subscription, plans);
    if (!/^sub_[A-Za-z0-9]{8,40}$/.test(subscriptionId) || !/^\d{17,20}$/.test(guildId) || !period) return null;

    const existing = await repo.findPurchaseBySubscription(subscriptionId);
    if (existing) return existing;

    const buyer = await repo.findBuyer(subscriptionId);
    let amount = { amount_paise: null, currency: null };
    try {
        const fetched = await fetchPlanAmount(subscription.plan_id);
        if (Number.isInteger(fetched?.amount_paise)) amount = { amount_paise: fetched.amount_paise, currency: fetched.currency || 'INR' };
    } catch {
        // The purchase is still recorded; the amount stays unknown rather than guessed.
    }
    const first = Boolean(buyer?.user_id) && (await repo.countPurchases(buyer.user_id)) === 0;
    const row = {
        subscription_id: subscriptionId,
        guild_id: guildId,
        user_id: buyer?.user_id || null,
        discord_user_id: buyer?.discord_user_id || null,
        plan_period: period,
        ...amount,
        is_first_purchase: first,
        feedback_state: first ? 'pending' : 'not_offered',
        verified_at: new Date(now).toISOString()
    };
    let { data, error } = await repo.insertPurchase(row);
    if (error && isUnique(error, 'first_idx')) {
        // Another first purchase by this buyer won the race: this one is not first.
        ({ data, error } = await repo.insertPurchase({ ...row, is_first_purchase: false, feedback_state: 'not_offered' }));
    }
    if (error && isUnique(error)) return repo.findPurchaseBySubscription(subscriptionId);
    if (error) throw new Error(`Purchase record failed: ${error.message}`);
    return data;
}

/** The buyer's pending first-purchase form, or null. */
async function loadPendingFeedback({ repo, userId, now = Date.now() }) {
    if (!userId) return null;
    const purchase = await repo.findFirstPurchase(userId);
    if (!purchase || purchase.feedback_state !== 'pending') return null;
    const remindAfter = Date.parse(purchase.feedback_remind_after || '');
    return {
        purchaseId: purchase.id,
        planPeriod: purchase.plan_period,
        planLabel: planLabel(purchase),
        snoozedUntil: Number.isFinite(remindAfter) && remindAfter > now ? new Date(remindAfter).toISOString() : null
    };
}

async function ownPendingPurchase(repo, userId, purchaseId) {
    if (!UUID.test(String(purchaseId || ''))) throw new FeedbackError(400, 'Invalid purchase.');
    const purchase = await repo.findPurchase(purchaseId);
    // Someone else's purchase looks exactly like a missing one.
    if (!purchase || !userId || purchase.user_id !== userId) throw new FeedbackError(404, 'There is no feedback form for that purchase.');
    if (!purchase.is_first_purchase || purchase.feedback_state === 'not_offered') throw new FeedbackError(409, 'This purchase has no feedback form.');
    if (purchase.feedback_state === 'submitted') throw new FeedbackError(409, 'You already sent feedback for this purchase. Thank you!');
    return purchase;
}

/** Store the buyer's answers once. The plan and amount come from the purchase. */
async function submitFeedback({ repo, userId, purchaseId, input, now = Date.now() }) {
    const purchase = await ownPendingPurchase(repo, userId, purchaseId);
    const result = validateFeedback(input, { planPeriod: purchase.plan_period });
    if (!result.ok) throw new FeedbackError(422, 'Some answers need fixing.', { fieldErrors: result.errors });
    const { error } = await repo.insertFeedback({
        ...result.value,
        purchase_id: purchase.id,
        user_id: userId,
        discord_user_id: purchase.discord_user_id,
        plan_period: purchase.plan_period,
        amount_paise: purchase.amount_paise,
        currency: purchase.currency,
        submitted_at: new Date(now).toISOString()
    });
    if (error && isUnique(error)) throw new FeedbackError(409, 'You already sent feedback for this purchase. Thank you!');
    if (error) throw new Error(`Feedback save failed: ${error.message}`);
    await repo.updatePurchase(purchase.id, { feedback_state: 'submitted', feedback_remind_after: null });
    return { submitted: true };
}

/** "Remind Me Later": keep it pending, hide it for a day. */
async function remindLater({ repo, userId, purchaseId, now = Date.now() }) {
    const purchase = await ownPendingPurchase(repo, userId, purchaseId);
    const until = new Date(now + FEEDBACK_REMIND_LATER_HOURS * 3_600_000).toISOString();
    await repo.updatePurchase(purchase.id, { feedback_remind_after: until });
    return { snoozedUntil: until };
}

module.exports = { FeedbackError, planPeriodOf, recordVerifiedPurchase, loadPendingFeedback, submitFeedback, remindLater };
