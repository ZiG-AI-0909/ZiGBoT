import 'server-only';
import shared from './shared';
import { createServiceClient } from './supabase/server';
import { env } from './env';
import { isHomeGuild } from './guildData';

const { isPremiumActive, subscriptionRowFromRazorpay, shouldReplaceSubscription } = shared;

const COLUMNS = 'guild_id, subscription_id, plan_period, status, current_period_end, cancel_at_period_end, pending_subscription_id';

/** The server's stored subscription row (service role; caller already verified access). */
export async function getStoredSubscription(guildId) {
    const { data, error } = await createServiceClient()
        .from('zb_guild_subscriptions').select(COLUMNS).eq('guild_id', String(guildId)).maybeSingle();
    if (error) throw new Error(`Subscription read failed: ${error.message}`);
    return data || null;
}

/**
 * What the editor shows about the server's plan. Never throws for a missing
 * table. Servers YOU own (HOME_GUILD_IDS / BOT_CREATOR_ID) are always Premium.
 */
export async function loadPlan(guild) {
    const home = isHomeGuild(guild);
    let subscription = null;
    try {
        subscription = await getStoredSubscription(guild.id);
    } catch (error) {
        console.error('[dashboard] plan lookup failed:', error?.message);
    }
    return {
        premium: home || isPremiumActive(subscription),
        isHome: home,
        status: subscription?.status || null,
        period: subscription?.plan_period || null,
        currentPeriodEnd: subscription?.current_period_end || null,
        cancelAtPeriodEnd: Boolean(subscription?.cancel_at_period_end),
        checkoutPending: Boolean(subscription?.pending_subscription_id) || ['created', 'authenticated'].includes(subscription?.status),
        billingEnabled: env.billingEnabled,
        prices: env.premiumPriceLabels
    };
}

async function upsert(row) {
    const { data, error } = await createServiceClient()
        .from('zb_guild_subscriptions').upsert(row, { onConflict: 'guild_id' }).select(COLUMNS).maybeSingle();
    if (error) throw new Error(`Subscription save failed: ${error.message}`);
    return data;
}

/**
 * Store a subscription fetched FROM RAZORPAY. `expectedGuildId` (from a
 * verified admin request) must match the server the payment was made for.
 * Returns the stored row, or null when nothing was stored.
 */
export async function syncSubscription(razorpaySubscription, { expectedGuildId = null, purchasedBy = null, cancelAtPeriodEnd = false } = {}) {
    const guildId = String(razorpaySubscription?.notes?.guild_id || '');
    if (expectedGuildId && guildId !== String(expectedGuildId)) return null;
    const existing = await getStoredSubscription(guildId).catch(() => null);
    const row = subscriptionRowFromRazorpay(razorpaySubscription, { plans: env.razorpayPlans, existing });
    if (!row) return null;
    if (cancelAtPeriodEnd && row.status === 'active') row.cancel_at_period_end = true;
    // An unpaid checkout never replaces a running Premium; it waits as "pending".
    if (!shouldReplaceSubscription(existing, row)) return existing;
    // Becoming the pending checkout clears it; otherwise keep any pending one.
    row.pending_subscription_id = existing?.pending_subscription_id && existing.pending_subscription_id !== row.subscription_id
        ? existing.pending_subscription_id
        : null;
    if (purchasedBy && existing?.subscription_id !== row.subscription_id) row.purchased_by = purchasedBy;
    return upsert(row);
}

/**
 * Remember a just-created (unpaid) subscription so the return/poll can find
 * it. A server without running Premium stores it as its row; a server whose
 * Premium is still running keeps that and parks the new id as pending.
 */
export async function recordCheckout(razorpaySubscription, { guildId, purchasedBy }) {
    const existing = await getStoredSubscription(guildId);
    if (existing && isPremiumActive(existing)) {
        const { error } = await createServiceClient()
            .from('zb_guild_subscriptions').update({ pending_subscription_id: razorpaySubscription.id, updated_at: new Date().toISOString() })
            .eq('guild_id', String(guildId));
        if (error) throw new Error(`Subscription save failed: ${error.message}`);
        return;
    }
    await syncSubscription(razorpaySubscription, { expectedGuildId: guildId, purchasedBy });
}
