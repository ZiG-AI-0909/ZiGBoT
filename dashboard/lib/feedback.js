import 'server-only';
import purchases from './shared/purchases';
import { createServiceClient } from './supabase/server';
import { getPlanAmount } from './razorpay';
import { env } from './env';

// Supabase storage for verified purchases and first-purchase feedback (the
// rules live in lib/shared/purchases.js). Service role only: callers have
// already identified the user (requireUser) or verified the payment.

const PURCHASES = 'zb_premium_purchases';
const FEEDBACK = 'zb_premium_feedback';

export function supabaseRepo(db = createServiceClient()) {
    const one = async (query) => {
        const { data, error } = await query.maybeSingle();
        if (error) throw new Error(`Purchase read failed: ${error.message}`);
        return data || null;
    };
    return {
        findPurchaseBySubscription: (subscriptionId) => one(db.from(PURCHASES).select('*').eq('subscription_id', subscriptionId)),
        findPurchase: (id) => one(db.from(PURCHASES).select('*').eq('id', id)),
        findFirstPurchase: (userId) => one(db.from(PURCHASES).select('*').eq('user_id', userId).eq('is_first_purchase', true)),
        async findBuyer(subscriptionId) {
            // The admin who started the checkout (recorded by recordCheckout/verify).
            // subscriptionId is already checked against ^sub_[A-Za-z0-9]+$, so it is safe in the filter.
            const sub = await one(db.from('zb_guild_subscriptions').select('purchased_by').or(`subscription_id.eq.${subscriptionId},pending_subscription_id.eq.${subscriptionId}`));
            if (!sub?.purchased_by) return null;
            const profile = await one(db.from('zb_profiles').select('discord_user_id').eq('user_id', sub.purchased_by));
            return { user_id: sub.purchased_by, discord_user_id: profile?.discord_user_id || null };
        },
        async countPurchases(userId) {
            const { count, error } = await db.from(PURCHASES).select('id', { count: 'exact', head: true }).eq('user_id', userId);
            if (error) throw new Error(`Purchase count failed: ${error.message}`);
            return count || 0;
        },
        insertPurchase: (row) => db.from(PURCHASES).insert(row).select('*').single(),
        insertFeedback: (row) => db.from(FEEDBACK).insert(row),
        async updatePurchase(id, fields) {
            const { error } = await db.from(PURCHASES).update(fields).eq('id', id);
            if (error) throw new Error(`Purchase update failed: ${error.message}`);
        }
    };
}

/**
 * Called by billing after Razorpay confirmed a subscription. Never throws:
 * Premium activation must not depend on the feedback feature.
 */
export async function recordPurchaseSafely(subscription) {
    try {
        return await purchases.recordVerifiedPurchase({ repo: supabaseRepo(), subscription, plans: env.razorpayPlans, fetchPlanAmount: getPlanAmount });
    } catch (error) {
        console.error('[feedback] purchase record failed:', error?.message || error);
        return null;
    }
}
