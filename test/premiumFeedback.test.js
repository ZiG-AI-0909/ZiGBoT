const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const purchases = require('../dashboard/lib/shared/purchases');
const { validateFeedback, planLabel, FEEDBACK_OPTIONS } = require('../dashboard/lib/shared/feedback');

// First-purchase Premium feedback. Storage is an in-memory repository with
// the same uniqueness rules as the real tables (checked against Postgres at
// the end); Razorpay is faked. These tests prove the rules, not a live payment.

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\r\n/g, '\n');
const PLANS = { monthly: 'plan_MONTHLY00001', yearly: 'plan_YEARLY000001' };
const PRICES = { [PLANS.monthly]: 39900, [PLANS.yearly]: 399900 };
const ALICE = '00000000-0000-4000-8000-00000000000a';
const BOB = '00000000-0000-4000-8000-00000000000b';
const G = '900000000000000001';
let n = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;

function memoryRepo({ buyers = {} } = {}) {
    const purchaseRows = [];
    const feedbackRows = [];
    const unique = (message) => ({ data: null, error: { code: '23505', message } });
    return {
        purchaseRows,
        feedbackRows,
        findPurchaseBySubscription: async (id) => purchaseRows.find((p) => p.subscription_id === id) || null,
        findPurchase: async (id) => purchaseRows.find((p) => p.id === id) || null,
        findFirstPurchase: async (userId) => purchaseRows.find((p) => p.user_id === userId && p.is_first_purchase) || null,
        findBuyer: async (subscriptionId) => buyers[subscriptionId] || null,
        countPurchases: async (userId) => purchaseRows.filter((p) => p.user_id === userId).length,
        async insertPurchase(row) {
            if (purchaseRows.some((p) => p.subscription_id === row.subscription_id)) return unique('duplicate key value violates unique constraint "zb_premium_purchases_subscription_id_key"');
            if (row.is_first_purchase && purchaseRows.some((p) => p.user_id === row.user_id && p.is_first_purchase)) return unique('duplicate key value violates unique constraint "zb_premium_purchases_first_idx"');
            const stored = { id: uuid(), feedback_remind_after: null, ...row };
            purchaseRows.push(stored);
            return { data: stored, error: null };
        },
        async insertFeedback(row) {
            if (feedbackRows.some((f) => f.purchase_id === row.purchase_id)) return unique('duplicate key value violates unique constraint "zb_premium_feedback_purchase_id_key"');
            feedbackRows.push({ id: uuid(), ...row });
            return { error: null };
        },
        async updatePurchase(id, fields) {
            Object.assign(purchaseRows.find((p) => p.id === id), fields);
        }
    };
}

const subscription = (id, plan, status = 'active') => ({ id, plan_id: PLANS[plan], status, notes: { guild_id: G } });
const fetchPlanAmount = async (planId) => ({ amount_paise: PRICES[planId], currency: 'INR' });
const record = (repo, sub) => purchases.recordVerifiedPurchase({ repo, subscription: sub, plans: PLANS, fetchPlanAmount });

const goodAnswers = (extra = {}) => ({
    overall_rating: 5, activation_ease: 4, value_for_money: 'good',
    purchase_reasons: ['ai_personas', 'support_dev'], valuable_features: ['anti_nuke', 'music_voice'],
    issues: ['none'], recommend_score: 9, comments: 'Love it',
    ...extra
});
const monthlyAnswers = (extra) => goodAnswers({ meets_expectations: 'yes', more_useful: 'More GIF styles', ...extra });
const yearlyAnswers = (extra) => goodAnswers({ justifies_price: 'mostly', needs_onboarding: 'no', advanced_capabilities: ['custom_persona'], meets_requirements: 'yes', ...extra });

test('1. a first-time ₹399 buyer gets the form, labelled from the verified amount', async () => {
    const repo = memoryRepo({ buyers: { sub_AAAAAAAA01: { user_id: ALICE, discord_user_id: '100000000000000001' } } });
    const purchase = await record(repo, subscription('sub_AAAAAAAA01', 'monthly'));
    assert.equal(purchase.is_first_purchase, true);
    assert.equal(purchase.feedback_state, 'pending');
    assert.equal(purchase.amount_paise, 39900);
    const pending = await purchases.loadPendingFeedback({ repo, userId: ALICE });
    assert.deepEqual(pending, { purchaseId: purchase.id, planPeriod: 'monthly', planLabel: '₹399 Premium', snoozedUntil: null });
    assert.deepEqual(await purchases.submitFeedback({ repo, userId: ALICE, purchaseId: purchase.id, input: monthlyAnswers() }), { submitted: true });
    const stored = repo.feedbackRows[0];
    assert.equal(stored.plan_period, 'monthly');
    assert.equal(stored.amount_paise, 39900);
    assert.deepEqual(stored.plan_answers, { meets_expectations: 'yes', more_useful: 'More GIF styles' });
    assert.equal(stored.discord_user_id, '100000000000000001');
});

test('2. a first-time ₹3,999 buyer gets the yearly questions, and they are required', async () => {
    const repo = memoryRepo({ buyers: { sub_BBBBBBBB01: { user_id: BOB } } });
    const purchase = await record(repo, subscription('sub_BBBBBBBB01', 'yearly'));
    const pending = await purchases.loadPendingFeedback({ repo, userId: BOB });
    assert.equal(pending.planLabel, '₹3,999 Premium');
    assert.equal(pending.planPeriod, 'yearly');
    await assert.rejects(
        purchases.submitFeedback({ repo, userId: BOB, purchaseId: purchase.id, input: goodAnswers() }),
        (e) => e.status === 422 && ['justifies_price', 'needs_onboarding', 'meets_requirements'].every((f) => e.extra.fieldErrors[f])
    );
    await purchases.submitFeedback({ repo, userId: BOB, purchaseId: purchase.id, input: yearlyAnswers({ meets_expectations: 'yes' }) });
    assert.deepEqual(repo.feedbackRows[0].plan_answers, { justifies_price: 'mostly', needs_onboarding: 'no', advanced_capabilities: ['custom_persona'], meets_requirements: 'yes' }, 'monthly-only answers are ignored');
});

test('3. failed, pending or unknown payments never record a purchase or show the form', async () => {
    const repo = memoryRepo({ buyers: { sub_CCCCCCCC01: { user_id: ALICE } } });
    for (const status of ['created', 'authenticated', 'pending', 'halted', 'cancelled', 'expired', 'paused', 'completed']) {
        assert.equal(await record(repo, subscription('sub_CCCCCCCC01', 'monthly', status)), null, status);
    }
    assert.equal(await record(repo, { ...subscription('sub_CCCCCCCC01', 'monthly'), plan_id: 'plan_SOMEONEELSE1' }), null, 'not one of our plans');
    assert.equal(await record(repo, { ...subscription('sub_CCCCCCCC01', 'monthly'), notes: {} }), null, 'no server');
    assert.equal(repo.purchaseRows.length, 0);
    assert.equal(await purchases.loadPendingFeedback({ repo, userId: ALICE }), null);
});

test('4. "Remind Me Later" keeps it pending and brings it back after a day', async () => {
    const repo = memoryRepo({ buyers: { sub_DDDDDDDD01: { user_id: ALICE } } });
    const purchase = await record(repo, subscription('sub_DDDDDDDD01', 'monthly'));
    const t = Date.parse('2026-10-29T10:00:00Z');
    const { snoozedUntil } = await purchases.remindLater({ repo, userId: ALICE, purchaseId: purchase.id, now: t });
    assert.equal(snoozedUntil, '2026-10-30T10:00:00.000Z');
    const later = await purchases.loadPendingFeedback({ repo, userId: ALICE, now: t + 3_600_000 });
    assert.equal(later.snoozedUntil, snoozedUntil, 'still pending, just snoozed (the banner offers it)');
    assert.equal((await purchases.loadPendingFeedback({ repo, userId: ALICE, now: t + 25 * 3_600_000 })).snoozedUntil, null, 'shows again');
});

test('5/7. a submitted form never comes back, and duplicate submissions are refused', async () => {
    const repo = memoryRepo({ buyers: { sub_EEEEEEEE01: { user_id: ALICE } } });
    const purchase = await record(repo, subscription('sub_EEEEEEEE01', 'monthly'));
    const results = await Promise.allSettled([1, 2, 3].map(() => purchases.submitFeedback({ repo, userId: ALICE, purchaseId: purchase.id, input: monthlyAnswers() })));
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1, 'double clicks store one response');
    assert.ok(results.filter((r) => r.status === 'rejected').every((r) => r.reason.status === 409));
    assert.equal(repo.feedbackRows.length, 1);
    assert.equal(await purchases.loadPendingFeedback({ repo, userId: ALICE }), null);
    await assert.rejects(purchases.submitFeedback({ repo, userId: ALICE, purchaseId: purchase.id, input: monthlyAnswers() }), (e) => e.status === 409);
    await assert.rejects(purchases.remindLater({ repo, userId: ALICE, purchaseId: purchase.id }), (e) => e.status === 409);
});

test('6. an upgrade or renewal is never treated as a first purchase', async () => {
    const repo = memoryRepo({ buyers: { sub_FFFFFFFF01: { user_id: ALICE }, sub_FFFFFFFF02: { user_id: ALICE } } });
    const first = await record(repo, subscription('sub_FFFFFFFF01', 'monthly'));
    // Renewal webhooks for the same subscription: still one purchase.
    assert.equal((await record(repo, subscription('sub_FFFFFFFF01', 'monthly'))).id, first.id);
    assert.equal(repo.purchaseRows.length, 1);
    // Upgrade to ₹3,999: a second purchase, no new form.
    const upgrade = await record(repo, subscription('sub_FFFFFFFF02', 'yearly'));
    assert.equal(upgrade.is_first_purchase, false);
    assert.equal(upgrade.feedback_state, 'not_offered');
    assert.equal((await purchases.loadPendingFeedback({ repo, userId: ALICE })).purchaseId, first.id, 'only the first purchase\'s form');
    await assert.rejects(purchases.submitFeedback({ repo, userId: ALICE, purchaseId: upgrade.id, input: yearlyAnswers() }), (e) => e.status === 409);
    // Two first purchases racing: the database index keeps exactly one first.
    const race = memoryRepo({ buyers: { sub_GGGGGGGG01: { user_id: BOB }, sub_GGGGGGGG02: { user_id: BOB } } });
    race.countPurchases = async () => 0; // both see "no purchases yet"
    await Promise.all([record(race, subscription('sub_GGGGGGGG01', 'monthly')), record(race, subscription('sub_GGGGGGGG02', 'yearly'))]);
    assert.equal(race.purchaseRows.filter((p) => p.is_first_purchase).length, 1);
    assert.equal(race.purchaseRows.length, 2);
});

test('8. users can never see, submit or snooze someone else\'s form', async () => {
    const repo = memoryRepo({ buyers: { sub_HHHHHHHH01: { user_id: ALICE } } });
    const purchase = await record(repo, subscription('sub_HHHHHHHH01', 'monthly'));
    assert.equal(await purchases.loadPendingFeedback({ repo, userId: BOB }), null);
    await assert.rejects(purchases.submitFeedback({ repo, userId: BOB, purchaseId: purchase.id, input: monthlyAnswers() }), (e) => e.status === 404);
    await assert.rejects(purchases.remindLater({ repo, userId: BOB, purchaseId: purchase.id }), (e) => e.status === 404);
    await assert.rejects(purchases.submitFeedback({ repo, userId: null, purchaseId: purchase.id, input: monthlyAnswers() }), (e) => e.status === 404);
    await assert.rejects(purchases.submitFeedback({ repo, userId: ALICE, purchaseId: 'not-a-uuid', input: monthlyAnswers() }), (e) => e.status === 400);
    // A purchase with no known buyer (e.g. made outside the dashboard) never shows a form.
    const orphan = await record(memoryRepo(), subscription('sub_HHHHHHHH02', 'monthly'));
    assert.equal(orphan.is_first_purchase, false);
    // The routes use the signed-in session, never a user id from the request.
    for (const route of ['dashboard/app/api/feedback/route.js', 'dashboard/app/api/feedback/remind/route.js']) {
        const code = read(route);
        assert.match(code, /const \{ user \} = await requireUser\(\);/);
        assert.match(code, /userId: user\.id/);
        assert.doesNotMatch(code, /body\?\.userId|body\?\.plan|body\?\.amount/);
    }
});

test('the plan and price come from Razorpay and our config, never the browser', async () => {
    const repo = memoryRepo({ buyers: { sub_IIIIIIII01: { user_id: ALICE } } });
    const purchase = await record(repo, subscription('sub_IIIIIIII01', 'yearly'));
    await purchases.submitFeedback({ repo, userId: ALICE, purchaseId: purchase.id, input: yearlyAnswers({ plan_period: 'monthly', amount_paise: 1, user_id: BOB }) });
    const stored = repo.feedbackRows[0];
    assert.equal(stored.plan_period, 'yearly');
    assert.equal(stored.amount_paise, 399900);
    assert.equal(stored.user_id, ALICE);
    // If Razorpay can't be asked for the price, it is unknown, never guessed.
    const unknown = await purchases.recordVerifiedPurchase({ repo: memoryRepo(), subscription: subscription('sub_IIIIIIII02', 'monthly'), plans: PLANS, fetchPlanAmount: async () => { throw new Error('down'); } });
    assert.equal(unknown.amount_paise, null);
    assert.equal(planLabel(unknown), 'Monthly Premium');
    // Billing records purchases only after Razorpay says "active", without risking activation.
    const billing = read('dashboard/lib/billing.js');
    assert.match(billing, /if \(stored\?\.status === 'active' && stored\.subscription_id === razorpaySubscription\.id\) await recordPurchaseSafely\(razorpaySubscription\);/);
    assert.match(read('dashboard/lib/feedback.js'), /export async function recordPurchaseSafely[\s\S]*catch \(error\) \{[\s\S]*return null;/);
});

test('validation: required answers, known options only, sane text', () => {
    const bad = validateFeedback({ overall_rating: 6, activation_ease: 0, value_for_money: 'meh', issues: ['none', 'performance'], recommend_score: 11, purchase_reasons: ['hacking'], comments: 'x'.repeat(2001) }, { planPeriod: 'monthly' });
    assert.equal(bad.ok, false);
    for (const field of ['overall_rating', 'activation_ease', 'value_for_money', 'issues', 'recommend_score', 'purchase_reasons', 'comments', 'meets_expectations']) assert.ok(bad.errors[field], field);
    const ok = validateFeedback(monthlyAnswers({ comments: '  hi\u0000 there  ', recommend_score: 0 }), { planPeriod: 'monthly' });
    assert.equal(ok.ok, true);
    assert.equal(ok.value.comments, 'hi there');
    assert.equal(ok.value.recommend_score, 0, '0 is a valid score');
    assert.equal(validateFeedback(monthlyAnswers(), { planPeriod: 'lifetime' }).errors.plan, 'Unknown plan.');
    // Feature options are real ZiGBoT features (none marked as coming soon).
    const features = FEEDBACK_OPTIONS.valuable_features.map(([k]) => k);
    assert.ok(features.includes('anti_nuke') && features.includes('automation') && features.includes('memory'));
});

test('10. the form is usable on mobile and with a keyboard', () => {
    const css = read('dashboard/app/globals.css');
    assert.match(css, /\.fb-options \{[^}]*grid-template-columns: repeat\(auto-fill, minmax\(220px, 1fr\)\)/, 'options wrap on small screens');
    assert.match(css, /\.fb-step \{[^}]*min-width: 44px; min-height: 44px/, '44 px touch targets');
    assert.match(css, /\.fb-dialog \{ width: min\(640px, 100%\); max-height: calc\(100vh - 32px\); overflow-y: auto; \}/);
    const ui = read('dashboard/components/FeedbackPrompt.js');
    assert.match(ui, /role="dialog" aria-modal="true" aria-labelledby="fb-title"/);
    assert.match(ui, /role="progressbar"/);
    assert.match(ui, /event\.key === 'Escape'/);
    for (const text of ['Help Us Make ZiGBoT Better 💜', 'Submit Feedback', 'Remind Me Later', 'Tell us what you\'d like to see in ZiGBoT...', 'Thank you for being part of ZiGBoT! 💜']) assert.ok(ui.includes(text), text);
    assert.match(read('dashboard/app/dashboard/layout.js'), /<FeedbackPrompt \/>/, 'checked on every dashboard visit');
    assert.equal((read('dashboard/components/GuildEditor.js').match(/zigbot:premium-verified/g) || []).length, 2, 'and right after both checkout paths');
});

test('the database enforces one first purchase per user and one response per purchase; browsers get nothing', async () => {
    const { PGlite } = await import('@electric-sql/pglite');
    const db = new PGlite();
    await db.exec(`
        create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
        create schema auth; create table auth.users (id uuid primary key);
        create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
        create schema storage; create table storage.buckets (id text primary key, name text not null, public boolean default false, file_size_limit bigint, allowed_mime_types text[]);
        grant usage on schema public to anon, authenticated, service_role;
        alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    `);
    const migrations = fs.readdirSync(path.join(ROOT, 'supabase', 'migrations')).filter((f) => f.endsWith('.sql')).sort()
        .map((f) => fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', f), 'utf8')).join('\n');
    await db.exec(migrations);
    await db.exec(migrations);
    await db.exec(`insert into auth.users (id) values ('${ALICE}')`);
    await db.exec('set role service_role');
    const insert = (sub, first) => db.query('insert into public.zb_premium_purchases (subscription_id, guild_id, user_id, plan_period, is_first_purchase) values ($1, $2, $3, $4, $5) returning id', [sub, G, ALICE, 'monthly', first]);
    const { rows: [p] } = await insert('sub_JJJJJJJJ01', true);
    await assert.rejects(insert('sub_JJJJJJJJ02', true), /zb_premium_purchases_first_idx/);
    await insert('sub_JJJJJJJJ02', false);
    await assert.rejects(insert('sub_JJJJJJJJ02', false), /subscription_id/);
    const fb = () => db.query("insert into public.zb_premium_feedback (purchase_id, user_id, plan_period, overall_rating, activation_ease, value_for_money, recommend_score) values ($1, $2, 'monthly', 5, 4, 'good', 9)", [p.id, ALICE]);
    await fb();
    await assert.rejects(fb(), /purchase_id/);
    await assert.rejects(db.query("insert into public.zb_premium_feedback (purchase_id, plan_period, overall_rating, activation_ease, value_for_money, recommend_score) values ($1, 'monthly', 9, 4, 'good', 9)", [p.id]), /check constraint/);
    for (const role of ['authenticated', 'anon']) {
        await db.exec(`reset role; set role ${role}`);
        for (const table of ['zb_premium_purchases', 'zb_premium_feedback']) await assert.rejects(db.query(`select * from public.${table}`), /permission denied/);
    }
    await db.close();
});
