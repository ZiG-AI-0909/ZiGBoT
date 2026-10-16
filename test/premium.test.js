const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const {
    isPremiumActive,
    subscriptionRowFromRazorpay,
    shouldReplaceSubscription,
    applyPlanToConfig,
    applyPlanToMappings,
    configPremiumErrors,
    mappingsPremiumError,
    resolveMemberBehavior,
    FREE_LIMITS
} = require('../dashboard/lib/shared');
const { verifyRazorpaySignature, verifyRazorpaySubscriptionPayment } = require('../dashboard/lib/shared/razorpaySignature');
const { GuildConfigStore } = require('../src/guildConfig/store');
const { behaviorForMember, buildGuildSettings, rateLimitReplyFor, RATE_LIMIT_REPLY, FREE_TIER_EXHAUSTED_REPLY } = require('../src/guildConfig/context');
const { executeTool } = require('../src/tools/router');
const { RateLimiter } = require('../src/ai/rateLimiter');

const HOME = '510000000000000001';
const FREE = '510000000000000002';
const PAID = '510000000000000003';
const OWNER = '610000000000000001';
const NOW = Date.parse('2026-10-17T12:00:00Z');
const PLANS = { monthly: 'plan_Monthly0000001', yearly: 'plan_Yearly00000001' };

const settings = {
    serverOwnerId: OWNER,
    homeGuildIds: [],
    chatChannelIds: [],
    respondToAllMessages: false,
    autoReplyKeywords: true,
    cooldownSeconds: 15,
    aiRateLimitMax: 8,
    aiRateLimitPremiumMax: 30
};

function fakeSupabase(tables) {
    return async (url) => {
        const u = new URL(url);
        const table = u.pathname.split('/').pop();
        if (tables.failTable === table) return { ok: false, status: 404, text: async () => 'relation does not exist' };
        const gid = u.searchParams.get('guild_id')?.replace(/^eq\./, '');
        const rows = (tables[table] || []).filter((row) => !gid || row.guild_id === gid);
        return { ok: true, status: 200, text: async () => JSON.stringify(rows) };
    };
}

const guild = (id, ownerId = 'someone') => ({ id, ownerId, name: `Guild ${id}`, icon: null });

const mappings = (guildId, count) => Array.from({ length: count }, (_, i) => ({
    guild_id: guildId, role_id: `71000000000000000${i}`, tier: 'custom', priority: i, allowed_features: [], denied_features: []
}));

function makeStore(tables) {
    return new GuildConfigStore({ settings, supabaseUrl: 'https://x.supabase.co', serviceRoleKey: 'k', fetchImpl: fakeSupabase(tables), now: () => NOW, logger: { error() {} } });
}

// ---- plan status ----
test('premium status: active is premium; pending/cancelled only until the paid period ends; others never', () => {
    assert.equal(isPremiumActive(null, NOW), false);
    assert.equal(isPremiumActive({ status: 'active' }, NOW), true);
    for (const status of ['cancelled', 'pending']) {
        assert.equal(isPremiumActive({ status, current_period_end: '2026-11-01T00:00:00Z' }, NOW), true, `${status} within period`);
        assert.equal(isPremiumActive({ status, current_period_end: '2026-10-01T00:00:00Z' }, NOW), false, `${status} after period`);
        assert.equal(isPremiumActive({ status }, NOW), false, `${status} without a period`);
    }
    for (const status of ['created', 'authenticated', 'halted', 'completed', 'expired', 'paused']) {
        assert.equal(isPremiumActive({ status, current_period_end: '2030-01-01T00:00:00Z' }, NOW), false, status);
    }
});

test('Razorpay sync: only our plans with a valid server id ever become a subscription row', () => {
    const base = { id: 'sub_ABC123def456GH', plan_id: PLANS.yearly, notes: { guild_id: PAID }, status: 'active', current_end: Date.parse('2027-10-17T00:00:00Z') / 1000 };
    const row = subscriptionRowFromRazorpay(base, { plans: PLANS, now: NOW });
    assert.equal(row.guild_id, PAID);
    assert.equal(row.provider, 'razorpay');
    assert.equal(row.plan_period, 'yearly');
    assert.equal(row.status, 'active');
    assert.equal(row.current_period_end, '2027-10-17T00:00:00.000Z');
    assert.equal(row.cancel_at_period_end, false);

    assert.equal(subscriptionRowFromRazorpay({ ...base, plan_id: 'plan_SomeoneElses01' }, { plans: PLANS }), null, 'foreign plan');
    assert.equal(subscriptionRowFromRazorpay({ ...base, notes: { guild_id: 'abc' } }, { plans: PLANS }), null, 'bad server id');
    assert.equal(subscriptionRowFromRazorpay({ ...base, notes: {} }, { plans: PLANS }), null, 'no server id');
    assert.equal(subscriptionRowFromRazorpay({ ...base, status: 'paid' }, { plans: PLANS }), null, 'unknown status');
    assert.equal(subscriptionRowFromRazorpay({ ...base, id: 'I-PAYPAL00001' }, { plans: PLANS }), null, 'bad subscription id');
    assert.equal(subscriptionRowFromRazorpay(base, { plans: {} }), null, 'billing not configured');
});

test('Razorpay sync: paid-through date and the cancel-at-period-end flag survive later events', () => {
    const sub = { id: 'sub_ABC123def456GH', plan_id: PLANS.monthly, notes: { guild_id: PAID }, status: 'active' };
    const existing = { subscription_id: 'sub_ABC123def456GH', current_period_end: '2026-11-10T00:00:00Z', cancel_at_period_end: true };
    const row = subscriptionRowFromRazorpay(sub, { plans: PLANS, existing });
    assert.equal(row.current_period_end, '2026-11-10T00:00:00Z', 'kept when Razorpay omits current_end');
    assert.equal(row.cancel_at_period_end, true, 'a scheduled cancel is remembered while still active');
    assert.equal(subscriptionRowFromRazorpay({ ...sub, status: 'cancelled' }, { plans: PLANS, existing }).cancel_at_period_end, false);
    assert.equal(subscriptionRowFromRazorpay({ ...sub, id: 'sub_DifferentSub0001' }, { plans: PLANS, existing }).cancel_at_period_end, false, 'flag never leaks to another subscription');
});

test('Razorpay sync: an unpaid checkout or a late old event never replaces a running Premium', () => {
    const active = { subscription_id: 'sub_NewSubscription01', status: 'active' };
    const oldExpired = { subscription_id: 'sub_OldSubscription01', status: 'expired' };
    const unpaid = { subscription_id: 'sub_UnpaidCheckout001', status: 'created' };
    assert.equal(shouldReplaceSubscription(active, oldExpired, NOW), false);
    assert.equal(shouldReplaceSubscription(active, unpaid, NOW), false, 'checkout waits as pending');
    assert.equal(shouldReplaceSubscription(active, { ...active, status: 'halted' }, NOW), true, 'same subscription always updates');
    assert.equal(shouldReplaceSubscription(oldExpired, active, NOW), true);
    assert.equal(shouldReplaceSubscription(null, unpaid, NOW), true);
});

test('Razorpay webhook: only a valid HMAC of the exact raw body with our secret passes', () => {
    const secret = 'whsec_test_secret';
    const body = JSON.stringify({ event: 'subscription.activated', payload: { subscription: { entity: { id: 'sub_ABC123def456GH' } } } });
    const good = crypto.createHmac('sha256', secret).update(body).digest('hex');
    assert.equal(verifyRazorpaySignature(body, good, secret), true);
    assert.equal(verifyRazorpaySignature(body, good.toUpperCase(), secret), true, 'hex case does not matter');
    assert.equal(verifyRazorpaySignature(`${body} `, good, secret), false, 'tampered body');
    assert.equal(verifyRazorpaySignature(body, crypto.createHmac('sha256', 'other').update(body).digest('hex'), secret), false, 'wrong secret');
    assert.equal(verifyRazorpaySignature(body, '', secret), false);
    assert.equal(verifyRazorpaySignature(body, 'not-hex', secret), false);
    assert.equal(verifyRazorpaySignature(body, good, ''), false, 'no secret configured');
});

// ---- what free servers lose ----
test('free plan: custom persona is ignored and only the top role mappings apply', () => {
    const config = { custom_system_prompt: 'Pirate', replace_base_persona: true, server_rules: 'No spoilers' };
    const free = applyPlanToConfig(config, false);
    assert.equal(free.custom_system_prompt, '');
    assert.equal(free.replace_base_persona, false);
    assert.equal(free.server_rules, 'No spoilers', 'server rules stay free');
    assert.equal(applyPlanToConfig(config, true), config);

    const list = mappings(FREE, 5);
    const kept = applyPlanToMappings(list, false);
    assert.equal(kept.length, FREE_LIMITS.roleMappings);
    assert.deepEqual(kept.map((m) => m.priority), [4, 3, 2], 'highest priority first');
    assert.equal(applyPlanToMappings(list, true).length, 5);
});

test('free plan: voice and music are off even if a role mapping allows them', () => {
    const config = { default_tone: 'gentle' };
    const allowAll = [{ role_id: 'r1', priority: 1, allowed_features: ['music', 'voice'], denied_features: [] }];
    const free = resolveMemberBehavior({ config, mappings: allowAll, memberRoleIds: ['r1'], premium: false });
    assert.equal(free.features.has('music'), false);
    assert.equal(free.features.has('voice'), false);
    assert.equal(free.features.has('chat'), true);
    const paid = resolveMemberBehavior({ config, mappings: allowAll, memberRoleIds: ['r1'], premium: true });
    assert.equal(paid.features.has('music'), true);
    assert.equal(paid.features.has('voice'), true);
});

test('free plan: saving premium settings is rejected with field errors', () => {
    assert.deepEqual(Object.keys(configPremiumErrors({ custom_system_prompt: 'x', replace_base_persona: true })), ['custom_system_prompt', 'replace_base_persona']);
    assert.deepEqual(configPremiumErrors({ custom_system_prompt: '', replace_base_persona: false }), {});
    assert.equal(mappingsPremiumError(mappings(FREE, FREE_LIMITS.roleMappings)), null);
    assert.match(mappingsPremiumError(mappings(FREE, FREE_LIMITS.roleMappings + 1)), /Premium/);
});

// ---- the bot applies the plan at runtime ----
test('bot store: free, paid, lapsed and home servers get the right plan', async () => {
    const store = makeStore({
        zb_guild_configs: [
            { guild_id: FREE, custom_system_prompt: 'Saved while premium', replace_base_persona: true },
            { guild_id: PAID, custom_system_prompt: 'Pirate mode' },
            { guild_id: HOME, custom_system_prompt: 'Home persona' }
        ],
        zb_role_mappings: [...mappings(FREE, 5), ...mappings(PAID, 5)],
        zb_guild_subscriptions: [
            { guild_id: FREE, status: 'cancelled', current_period_end: '2026-10-01T00:00:00Z' },
            { guild_id: PAID, status: 'active' }
        ]
    });

    const free = await store.getGuildContext(guild(FREE));
    assert.equal(free.premium, false, 'cancelled and past the paid period');
    assert.equal(free.config.custom_system_prompt, '', 'lapsed premium cannot keep its custom persona');
    assert.equal(free.config.replace_base_persona, false);
    assert.equal(free.mappings.length, FREE_LIMITS.roleMappings);

    const paid = await store.getGuildContext(guild(PAID));
    assert.equal(paid.premium, true);
    assert.equal(paid.config.custom_system_prompt, 'Pirate mode');
    assert.equal(paid.mappings.length, 5);

    const home = await store.getGuildContext(guild(HOME, OWNER));
    assert.equal(home.premium, true, "the owner's home server is always premium");
    assert.equal(home.config.custom_system_prompt, 'Home persona');
});

test('bot store: a missing subscriptions table (migration not run) never breaks config loading', async () => {
    const store = makeStore({ zb_guild_configs: [{ guild_id: FREE, default_tone: 'neutral' }], zb_role_mappings: [], failTable: 'zb_guild_subscriptions' });
    const ctx = await store.getGuildContext(guild(FREE));
    assert.equal(ctx.source, 'db');
    assert.equal(ctx.config.default_tone, 'neutral');
    assert.equal(ctx.premium, false);
});

test('bot: premium servers get the higher AI limit; free and legacy keep the normal one', () => {
    const multi = (premium) => ({ mode: 'multi', guildId: FREE, premium, config: { default_tone: 'gentle' }, mappings: [] });
    assert.equal(buildGuildSettings(settings, multi(true)).aiRateLimitMax, 30);
    assert.equal(buildGuildSettings(settings, multi(false)).aiRateLimitMax, 8);
    assert.equal(buildGuildSettings(settings, { mode: 'legacy', premium: true, config: {}, mappings: [] }).aiRateLimitMax, 8);
    assert.equal(behaviorForMember(multi(false), { roles: { cache: new Map() } }).features.has('music'), false);
});

test('rate limiter: a per-call max overrides the default cap', () => {
    const limiter = new RateLimiter({ max: 2, windowMs: 60_000 });
    assert.equal(limiter.attempt('u', 1), true);
    assert.equal(limiter.attempt('u', 2), true);
    assert.equal(limiter.attempt('u', 3), false, 'default cap of 2');
    assert.equal(limiter.attempt('u', 4, { max: 5 }), true, 'premium cap of 5');
    assert.equal(limiter.attempt('u2', 5, { max: null }), true, 'null keeps the default');
});

test('router: music in a free server explains it is a Premium feature', async () => {
    const ctx = { mode: 'multi', guildId: FREE, premium: false, config: { default_tone: 'gentle', music_enabled: true }, mappings: [] };
    const user = '910000000000000001';
    const message = {
        author: { id: user },
        member: { id: user, roles: { cache: new Map() }, permissions: { has: () => false } },
        channel: { id: '810000000000000001', send: async () => {} },
        guild: { id: FREE, ownerId: 'someone', members: { me: { permissions: { has: () => true } }, cache: new Map() } }
    };
    const result = await executeTool(message, { ...settings, guildContext: ctx }, { action: 'queue_music' });
    assert.match(result, /Premium feature/);
});

test('Razorpay Checkout: the success signature must be HMAC(payment_id|subscription_id) with the key secret', () => {
    const secret = 'test_key_secret';
    const paymentId = 'pay_29QQoUBi66xm2f';
    const subscriptionId = 'sub_00000000000001';
    const sign = (text, key = secret) => crypto.createHmac('sha256', key).update(text).digest('hex');
    const ok = { paymentId, subscriptionId, signature: sign(`${paymentId}|${subscriptionId}`) };
    assert.equal(verifyRazorpaySubscriptionPayment(ok, secret), true);

    assert.equal(verifyRazorpaySubscriptionPayment({ ...ok, signature: sign(`${subscriptionId}|${paymentId}`) }, secret), false, 'order of fields matters');
    assert.equal(verifyRazorpaySubscriptionPayment({ ...ok, subscriptionId: 'sub_00000000000002' }, secret), false, 'signature for another subscription');
    assert.equal(verifyRazorpaySubscriptionPayment({ ...ok, signature: sign(`${paymentId}|${subscriptionId}`, 'webhook_secret') }, secret), false, 'wrong secret');
    assert.equal(verifyRazorpaySubscriptionPayment({ ...ok, paymentId: '' }, secret), false, 'missing payment id');
    assert.equal(verifyRazorpaySubscriptionPayment({ ...ok, subscriptionId: 'order_ABC12345678' }, secret), false, 'not a subscription id');
    assert.equal(verifyRazorpaySubscriptionPayment({ ...ok, signature: undefined }, secret), false, 'missing signature');
    assert.equal(verifyRazorpaySubscriptionPayment(ok, ''), false, 'no key secret configured');
});

test('rate limit reply: free servers are told the free version is exhausted and pointed to Premium', () => {
    const ctx = (premium, mode = 'multi') => ({ mode, guildId: FREE, premium, config: {}, mappings: [] });
    assert.equal(rateLimitReplyFor(buildGuildSettings(settings, ctx(false))), FREE_TIER_EXHAUSTED_REPLY);
    assert.match(FREE_TIER_EXHAUSTED_REPLY, /free version/i);
    assert.match(FREE_TIER_EXHAUSTED_REPLY, /Premium/);
    assert.match(FREE_TIER_EXHAUSTED_REPLY, /profile/i);
    // Premium servers, the owner's own servers (premium: true), legacy mode and DMs keep the normal cool-down.
    assert.equal(rateLimitReplyFor(buildGuildSettings(settings, ctx(true))), RATE_LIMIT_REPLY);
    assert.equal(rateLimitReplyFor(buildGuildSettings(settings, ctx(true, 'legacy'))), RATE_LIMIT_REPLY);
    assert.equal(rateLimitReplyFor(settings), RATE_LIMIT_REPLY);
});
