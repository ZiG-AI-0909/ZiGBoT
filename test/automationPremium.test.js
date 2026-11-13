// Platform Phase 3: creating automations is free, activating/executing is Premium (backend-enforced).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ent = require('../dashboard/lib/studio/entitlements');

const ROOT = path.join(__dirname, '..', 'dashboard');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const WF = ['app', 'api', 'studio', 'projects', '[projectId]', 'workflows', '[workflowId]'];
const NOW = Date.parse('2026-11-13T12:00:00Z');
const day = 86400000;
const iso = (t) => new Date(t).toISOString();

test('free users: design, save and preview are allowed; activation and execution are not', () => {
    const free = ent.resolveAutomationEntitlement({}, NOW);
    assert.equal(free.premium, false);
    for (const a of ['open', 'design', 'configure_triggers', 'save_draft', 'preview', 'view_execution_settings']) assert.equal(ent.canDo(a, free), true, a);
    for (const a of ['activate', 'execute', 'schedule', 'live_triggers', 'recurring']) assert.equal(ent.canDo(a, free), false, a);
    assert.equal(ent.canDo('something_new', { premium: true }), false, 'unknown actions are denied');
});

test('premium sources: server Premium subscription, Studio plan, home server, bot owner', () => {
    assert.equal(ent.resolveAutomationEntitlement({ subscriptions: [{ guild_id: '1', status: 'active', current_period_end: null }] }, NOW).source, 'server_premium');
    assert.equal(ent.resolveAutomationEntitlement({ studioPlan: 'developer' }, NOW).source, 'studio_developer');
    assert.equal(ent.resolveAutomationEntitlement({ studioPlan: 'premium', studioPlanExpiresAt: iso(NOW + day) }, NOW).premium, true);
    assert.equal(ent.resolveAutomationEntitlement({ managesHomeGuild: true }, NOW).source, 'home_server');
    assert.equal(ent.resolveAutomationEntitlement({ isBotOwner: true }, NOW).source, 'owner');
});

test('expiry: lapsed Studio plans and ended subscriptions stop counting immediately', () => {
    assert.equal(ent.resolveAutomationEntitlement({ studioPlan: 'premium', studioPlanExpiresAt: iso(NOW - 1) }, NOW).premium, false);
    assert.equal(ent.resolveAutomationEntitlement({ studioPlan: 'premium', studioPlanExpiresAt: 'garbage' }, NOW).premium, false, 'unreadable dates fail closed');
    assert.equal(ent.resolveAutomationEntitlement({ studioPlan: 'free', studioPlanExpiresAt: iso(NOW + day) }, NOW).premium, false);
    const cancelledRunning = { guild_id: '1', status: 'cancelled', current_period_end: iso(NOW + day) };
    const cancelledEnded = { guild_id: '2', status: 'cancelled', current_period_end: iso(NOW - day) };
    assert.equal(ent.resolveAutomationEntitlement({ subscriptions: [cancelledRunning] }, NOW).premium, true, 'cancelled plans last to the period end');
    assert.equal(ent.resolveAutomationEntitlement({ subscriptions: [cancelledEnded] }, NOW).premium, false);
    assert.equal(ent.resolveAutomationEntitlement({ subscriptions: [{ guild_id: '3', status: 'halted', current_period_end: iso(NOW + day) }] }, NOW).premium, false);
    assert.equal(ent.effectiveState({ active: true }, { premium: false }), 'paused_premium_expired');
    assert.equal(ent.effectiveState({ active: true }, { premium: true }), 'active');
    assert.equal(ent.effectiveState({ active: false }, { premium: true }), 'draft');
});

test('paywall explains why, what it unlocks, plans and how to upgrade', () => {
    const p = ent.paywall({ priceLabels: { monthly: '₹99/mo' }, billingEnabled: true });
    assert.equal(p.code, 'premium_required');
    assert.ok(p.why && p.unlocks.length >= 3 && p.howToUpgrade);
    assert.deepEqual(p.plans.map((x) => x.id), ['monthly', 'yearly']);
    assert.equal(p.plans[0].price, '₹99/mo');
    assert.match(ent.paywall({ billingEnabled: false }).howToUpgrade, /not switched on/);
});

test('backend enforcement: entitlement checked server-side on every activate and execute', () => {
    const activate = read(...WF, 'activate', 'route.js');
    const execute = read(...WF, 'execute', 'route.js');
    for (const src of [activate, execute]) {
        assert.match(src, /getAutomationEntitlement\(session\)/);
        assert.match(src, /if \(!entitlement\.premium\) throw new HttpError\(402/);
        assert.doesNotMatch(src, /body\??\.(premium|plan|entitlement)/, 'never trusts the client');
    }
    assert.ok(activate.indexOf('getAutomationEntitlement') < activate.indexOf('active: true, activated_at'), 'check before activating');
    assert.match(activate, /validateWorkflow\(workflow\.graph\)/, 'only valid workflows activate');
    assert.ok(execute.indexOf('getAutomationEntitlement') < execute.indexOf('getProvider'), 'check before anything runs');
    assert.match(execute, /runtime_not_available/, 'nothing runs on this server');
    const server = read('lib', 'studio', 'entitlementServer.js');
    assert.match(server, /return \{ premium: false, source: null, expiresAt: null, error: true \}/, 'fails closed');
    assert.match(server, /select\('guild_id'\)\.eq\('can_manage', true\)/, 'only servers the user manages');
    const crud = read(...WF, 'route.js');
    assert.match(crud, /workflow\.active && problems\.length/, 'invalid edits deactivate');
    const sql = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', '20261116000000_automation_premium.sql'), 'utf8');
    assert.match(sql, /grant update \(name, graph, updated_at\) on public\.studio_workflows to authenticated/);
});

test('builder UI: activation asks the server and shows the paywall on 402', () => {
    const ui = read('components', 'studio', 'WorkflowBuilder.js');
    assert.match(ui, /\/activate`, \{ method: 'POST'/);
    assert.match(ui, /e\.body\?\.code === 'premium_required'\) setPaywall/);
    const pw = read('components', 'studio', 'PremiumPaywall.js');
    assert.match(pw, /role="dialog" aria-modal="true"/);
    assert.match(pw, /e\.key === 'Escape'/);
});
