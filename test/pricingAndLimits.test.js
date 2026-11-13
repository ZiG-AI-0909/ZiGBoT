// Pricing (₹599 monthly, yearly recommended) and the Free / Premium split.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const pricing = require('../dashboard/lib/pricing');
const market = require('../dashboard/lib/studio/marketplace');
const ent = require('../dashboard/lib/studio/entitlements');

const ROOT = path.join(__dirname, '..', 'dashboard');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const api = (...p) => read('app', 'api', ...p);

test('monthly is ₹599, yearly unchanged at ₹3,999; yearly saving is computed from the labels', () => {
    const env = read('.env.example');
    assert.match(env, /^PREMIUM_PRICE_MONTHLY=₹599\/month$/m);
    assert.match(env, /^PREMIUM_PRICE_YEARLY=₹3,999\/year$/m);
    const s = pricing.yearlySavings({ monthly: '₹599/month', yearly: '₹3,999/year' });
    assert.deepEqual([s.amount, s.percent, s.months], [3189, 44, 5]);
    assert.equal(s.text, 'Save ₹3,189 (44%) a year');
    assert.equal(pricing.yearlySavings({ monthly: '₹100', yearly: '₹1,500' }), null, 'no saving claimed when there is none');
    assert.equal(pricing.yearlySavings({ monthly: 'soon', yearly: '₹3,999' }), null, 'unreadable labels claim nothing');
});

test('yearly is shown first and recommended everywhere people buy', () => {
    const editor = read('components', 'GuildEditor.js');
    assert.ok(editor.indexOf("checkout('yearly')") < editor.indexOf("checkout('monthly')"), 'Premium tab: yearly first');
    assert.match(editor, /⭐ Best value: \{yearlySavings\(plan\.prices\)\.text\}/);
    const page = read('app', 'page.js');
    assert.match(page, /Best value · \{savings\.text\}/);
    const pw = ent.paywall({ priceLabels: { monthly: '₹599/month', yearly: '₹3,999/year' } });
    assert.equal(pw.plans[0].id, 'yearly');
    assert.equal(pw.plans[0].recommended, true);
    assert.equal(pw.plans[0].saving, 'Save ₹3,189 (44%) a year');
    assert.doesNotMatch(read('app', 'admin', 'feedback', 'page.js') + read('lib', 'adminData.js'), /₹399|₹3,999/, 'admin labels follow the period, not an old price');
});

test('Free vs Premium limits: agent runs 10 vs 100, runners 1 vs 3, variables 5 vs 50, analytics 7 days vs full', () => {
    const f = market.limitsFor('free'); const p = market.limitsFor('premium');
    assert.deepEqual([f.agentRunsPerDay, f.runners, f.envVars, f.analyticsDays], [10, 1, 5, 7]);
    assert.deepEqual([p.agentRunsPerDay, p.runners, p.envVars, p.analyticsDays], [100, 3, 50, 400]);
    for (const route of [['studio', 'projects', '[projectId]', 'agent', 'route.js'], ['studio', 'projects', '[projectId]', 'workflows', 'generate', 'route.js']]) {
        const src = api(...route);
        assert.match(src, /market\.limitsFor\(await getEffectivePlan\(session\)\)\.agentRunsPerDay/, route.join('/'));
        assert.match(src, /limit: agentRunsPerDay,/);
    }
    assert.match(api('studio', 'projects', '[projectId]', 'runners', 'route.js'), /market\.limitsFor\(await getEffectivePlan\(session\)\)\.runners/);
    assert.match(api('studio', 'projects', '[projectId]', 'env', 'route.js'), /market\.limitsFor\(await getEffectivePlan\(session\)\)\.envVars/);
});

test('one Premium for both: a Premium server unlocks Studio Premium limits; expired Studio plans fall back to free', () => {
    const server = read('lib', 'studio', 'entitlementServer.js');
    assert.match(server, /export async function getEffectivePlan\(session\) \{\n\s+const entitlement = await getAutomationEntitlement\(session\);\n\s+if \(!entitlement\.premium\) return 'free';/);
    assert.match(server, /return entitlement\.source === 'studio_developer' \? 'developer' : 'premium';/);
    for (const f of [['studio', 'projects', '[projectId]', 'workflows', '[workflowId]', 'simulate', 'route.js'], ['studio', 'marketplace', 'route.js']]) assert.match(api(...f), /getEffectivePlan\(/);
});

test('analytics: Free 7 days and no CSV, Premium full history + CSV, decided on the server', () => {
    const route = api('guilds', '[guildId]', 'analytics', 'route.js');
    assert.match(route, /const \{ premium \} = await loadPlan\(guild\);/);
    assert.match(route, /if \(url\.searchParams\.get\('format'\) === 'csv' && !premium\) throw new HttpError\(402/);
    assert.match(route, /Math\.min\(Math\.max\([^;]+, 1\), maxDays\)/);
    assert.match(route, /const FREE_DAYS = 7;/);
    const tab = read('components', 'AnalyticsTab.js');
    assert.match(tab, /\{premium \? <a className="btn" href=\{`\/api\/guilds\/\$\{guildId\}\/analytics\?days=\$\{days\}&format=csv`\} download>Export CSV<\/a> : null\}/);
});
