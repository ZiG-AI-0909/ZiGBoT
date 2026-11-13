/**
 * Automation entitlements (Platform Phase 3).
 *
 * Creating automations is free: anyone can open the builder, add nodes,
 * configure triggers, save drafts and preview runs in the simulator.
 * ACTIVATING and EXECUTING them is Premium. This module decides that from
 * server-side data only (never from anything the browser says):
 *
 *   - a Studio plan (developer/premium) set by the ZiGBoT team, while
 *     studio_accounts.plan_expires_at is empty or in the future; or
 *   - Manage Server in a Discord server with active ZiGBoT Premium (the
 *     existing Razorpay subscription, same rule as everywhere else:
 *     isPremiumActive, so a cancelled plan lasts to its period end); or
 *   - the bot owner / a home server (always Premium, as in the bot).
 *
 * It is checked again on every activation and every execution request, so
 * an expired plan stops working immediately.
 */
const { isPremiumActive } = require('../shared/premium');

const PAID_STUDIO_PLANS = ['developer', 'premium'];

const toTime = (v) => { const t = v ? new Date(v).getTime() : NaN; return Number.isFinite(t) ? t : null; };

/**
 * @param {object} input
 *   studioPlan, studioPlanExpiresAt  from studio_accounts
 *   subscriptions                    zb_guild_subscriptions rows of servers the user manages
 *   managesHomeGuild, isBotOwner     booleans from server-side config
 * @returns {{ premium: boolean, source: string|null, expiresAt: string|null }}
 */
function resolveAutomationEntitlement({ studioPlan = 'free', studioPlanExpiresAt = null, subscriptions = [], managesHomeGuild = false, isBotOwner = false } = {}, now = Date.now()) {
    if (isBotOwner) return { premium: true, source: 'owner', expiresAt: null };
    if (managesHomeGuild) return { premium: true, source: 'home_server', expiresAt: null };
    if (PAID_STUDIO_PLANS.includes(studioPlan)) {
        const end = toTime(studioPlanExpiresAt);
        if (studioPlanExpiresAt === null || studioPlanExpiresAt === undefined || (end !== null && end > now)) {
            return { premium: true, source: `studio_${studioPlan}`, expiresAt: studioPlanExpiresAt || null };
        }
    }
    const active = (subscriptions || []).filter((s) => isPremiumActive(s, now));
    if (active.length) {
        // The latest-ending one (an 'active' status with no end counts as open-ended).
        const best = active.map((s) => ({ s, end: s.status === 'active' ? Infinity : toTime(s.current_period_end) || 0 })).sort((a, b) => b.end - a.end)[0];
        return { premium: true, source: 'server_premium', expiresAt: best.end === Infinity ? (best.s.current_period_end || null) : best.s.current_period_end, guildId: String(best.s.guild_id) };
    }
    return { premium: false, source: null, expiresAt: null };
}

/** What each tier may do with automations. */
const FREE_ACTIONS = Object.freeze(['open', 'design', 'configure_triggers', 'save_draft', 'preview', 'view_execution_settings']);
const PREMIUM_ACTIONS = Object.freeze(['activate', 'execute', 'schedule', 'live_triggers', 'recurring']);

function canDo(action, entitlement) {
    if (FREE_ACTIONS.includes(action)) return true;
    if (PREMIUM_ACTIONS.includes(action)) return Boolean(entitlement?.premium);
    return false;
}

/** The body of a 402 answer: why, what it unlocks, plans, how to upgrade. */
function paywall({ priceLabels = {}, billingEnabled = false } = {}) {
    return {
        code: 'premium_required',
        why: 'Running automations uses our servers around the clock (live triggers, schedules, retries), so activation is part of ZiGBoT Premium. Designing, saving and previewing stay free.',
        unlocks: [
            'Activate workflows so they react to live Discord events',
            'Scheduled and recurring automations',
            'Execute workflows on demand',
            'Higher daily limits for AI and simulator runs',
            'Everything in ZiGBoT Premium for your server'
        ],
        plans: [
            { id: 'monthly', label: 'Premium monthly', price: priceLabels.monthly || null },
            { id: 'yearly', label: 'Premium yearly', price: priceLabels.yearly || null }
        ],
        howToUpgrade: billingEnabled
            ? 'Open one of your servers in the dashboard, go to Premium and subscribe. Automations unlock for every server admin of a Premium server.'
            : 'Online checkout is not switched on yet. Contact the ZiGBoT team to get Premium.',
        upgradePath: '/dashboard'
    };
}

/** Effective state of a stored workflow for display: active only while still entitled. */
const effectiveState = (workflow, entitlement) => (workflow.active ? (entitlement?.premium ? 'active' : 'paused_premium_expired') : 'draft');

module.exports = { resolveAutomationEntitlement, canDo, paywall, effectiveState, FREE_ACTIONS, PREMIUM_ACTIONS, PAID_STUDIO_PLANS };
