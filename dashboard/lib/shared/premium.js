/**
 * ZiGBoT Premium: one source of truth for what a paid server unlocks, shared
 * by the bot (runtime enforcement) and the dashboard (save-time validation,
 * billing sync). CommonJS, like the rest of lib/shared.
 *
 * Premium is per server. The payment provider (Razorpay) is only ever
 * trusted through data fetched server-side from Razorpay itself; nothing here
 * reads a plan from browser input.
 *
 * Free servers lose, at runtime, anything that needs Premium — even if it was
 * saved while the server was Premium — so a lapsed subscription can never
 * keep paid features alive.
 */
const SNOWFLAKE = /^\d{17,20}$/;

const PREMIUM_PERIODS = Object.freeze(['monthly', 'yearly']);

// Free-plan caps. Premium uses the normal LIMITS from constants.js.
const FREE_LIMITS = Object.freeze({ roleMappings: 3 });

// Member features that only Premium servers get.
const PREMIUM_ONLY_FEATURES = Object.freeze(['music', 'voice']);

const PREMIUM_PERKS = Object.freeze([
    { key: 'ai_limits', title: 'Higher AI reply limits', text: 'Members can talk to ZiGBoT far more often before hitting the rate limit.' },
    { key: 'custom_persona', title: 'Custom persona', text: 'Write your own personality prompt or replace ZiGBoT’s persona entirely.' },
    { key: 'role_mappings', title: 'Unlimited role mappings', text: `Free servers can map ${FREE_LIMITS.roleMappings} roles; Premium can map up to 50.` },
    { key: 'voice_music', title: 'Voice & music', text: 'Voice conversations and music playback in your voice channels.' }
]);

// Razorpay subscription statuses we store.
const SUBSCRIPTION_STATUSES = Object.freeze(['created', 'authenticated', 'active', 'pending', 'halted', 'cancelled', 'completed', 'expired', 'paused']);

const SUBSCRIPTION_ID = /^sub_[A-Za-z0-9]{8,40}$/;

function toTime(value) {
    const time = value ? Date.parse(value) : NaN;
    return Number.isFinite(time) ? time : null;
}

/**
 * Is this stored subscription row currently paid for?
 *  - active: yes. (A cancel "at period end" keeps it active until then.)
 *  - pending (a renewal charge failed and Razorpay is retrying) and
 *    cancelled: yes until the end of the period already paid for.
 *  - created / authenticated (not charged yet), halted, completed, expired,
 *    paused, missing: no.
 */
function isPremiumActive(subscription, now = Date.now()) {
    if (!subscription) return false;
    if (subscription.status === 'active') return true;
    if (subscription.status === 'pending' || subscription.status === 'cancelled') {
        const end = toTime(subscription.current_period_end);
        return end !== null && end > now;
    }
    return false;
}

const unixToIso = (seconds) => (Number.isFinite(Number(seconds)) && Number(seconds) > 0 ? new Date(Number(seconds) * 1000).toISOString() : null);

/**
 * Convert a subscription entity fetched FROM RAZORPAY into our row. Returns
 * null when it is not one of our plans or has no valid server id, so a
 * foreign or malformed subscription can never unlock anything.
 */
function subscriptionRowFromRazorpay(subscription, { plans = {}, existing = null, now = Date.now() } = {}) {
    if (!subscription || typeof subscription !== 'object') return null;
    const period = PREMIUM_PERIODS.find((p) => plans[p] && plans[p] === subscription.plan_id);
    if (!period) return null;
    const guildId = String(subscription.notes?.guild_id || '');
    if (!SNOWFLAKE.test(guildId)) return null;
    const status = String(subscription.status || '').toLowerCase();
    if (!SUBSCRIPTION_STATUSES.includes(status)) return null;
    const id = String(subscription.id || '');
    if (!SUBSCRIPTION_ID.test(id)) return null;

    const sameSubscription = existing?.subscription_id === id;
    // Paid-through date: the end of the current billing cycle, or the one we
    // stored for this same subscription if Razorpay no longer reports it.
    const periodEnd = unixToIso(subscription.current_end)
        || (sameSubscription && toTime(existing.current_period_end) !== null ? existing.current_period_end : null);

    return {
        guild_id: guildId,
        provider: 'razorpay',
        subscription_id: id,
        plan_period: period,
        status,
        current_period_end: periodEnd,
        // Set by our cancel route; only meaningful while still active.
        cancel_at_period_end: status === 'active' && sameSubscription ? Boolean(existing.cancel_at_period_end) : false,
        updated_at: new Date(now).toISOString()
    };
}

/**
 * Should `incoming` overwrite the stored row? A late event about an old,
 * dead subscription must not wipe out a newer active one for the same server.
 */
function shouldReplaceSubscription(existing, incoming, now = Date.now()) {
    if (!incoming) return false;
    if (!existing) return true;
    if (existing.subscription_id === incoming.subscription_id) return true;
    return !(isPremiumActive(existing, now) && !isPremiumActive(incoming, now));
}

/** Free servers: custom persona is ignored. */
function applyPlanToConfig(config, premium) {
    if (premium || !config) return config;
    return { ...config, custom_system_prompt: '', replace_base_persona: false };
}

/** Free servers: only the top FREE_LIMITS.roleMappings mappings (by priority) apply. */
function applyPlanToMappings(mappings, premium) {
    const list = Array.isArray(mappings) ? mappings : [];
    if (premium || list.length <= FREE_LIMITS.roleMappings) return list;
    return list
        .map((mapping, index) => ({ mapping, index }))
        .sort((a, b) => (b.mapping.priority || 0) - (a.mapping.priority || 0) || a.index - b.index)
        .slice(0, FREE_LIMITS.roleMappings)
        .map(({ mapping }) => mapping);
}

/** Save-time check for a free server's config. Returns { field: message }. */
function configPremiumErrors(config) {
    const errors = {};
    if (config?.custom_system_prompt) errors.custom_system_prompt = 'A custom persona needs ZiGBoT Premium for this server.';
    if (config?.replace_base_persona) errors.replace_base_persona = 'Replacing the ZiGBoT persona needs ZiGBoT Premium for this server.';
    return errors;
}

/** Save-time check for a free server's role mappings. Returns a message or null. */
function mappingsPremiumError(mappings) {
    const count = Array.isArray(mappings) ? mappings.length : 0;
    return count > FREE_LIMITS.roleMappings
        ? `Free servers can map up to ${FREE_LIMITS.roleMappings} roles. Upgrade to ZiGBoT Premium for more.`
        : null;
}

module.exports = {
    PREMIUM_PERIODS,
    FREE_LIMITS,
    PREMIUM_ONLY_FEATURES,
    PREMIUM_PERKS,
    SUBSCRIPTION_STATUSES,
    isPremiumActive,
    subscriptionRowFromRazorpay,
    shouldReplaceSubscription,
    applyPlanToConfig,
    applyPlanToMappings,
    configPremiumErrors,
    mappingsPremiumError
};
