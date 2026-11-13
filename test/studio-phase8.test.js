// ZiGBoT Studio Phase 8: marketplace (static scan, review, install) + plans.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const market = require('../dashboard/lib/studio/marketplace');
const { generateProject } = require('../dashboard/lib/studio/generators');

const ROOT = path.join(__dirname, '..');
const API = path.join(ROOT, 'dashboard', 'app', 'api', 'studio', 'marketplace');
const TOKEN = `${'MTA'.padEnd(26, 'x')}.Gh1jK2.${'a'.repeat(38)}`;
const rules = (files) => market.scanFiles(files).findings.map((f) => f.rule);

test('static scan: credentials block publishing', () => {
    for (const [content, rule] of [[`const t = "${TOKEN}"`, 'discord-token'], ['k = "sk-proj-abcdefghijklmnopqrstuvwx"', 'openai-key'], ['gsk_abcdefghijklmnopqrstuvwxyz', 'groq-key'], ['ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'github-token'], ['AKIAABCDEFGHIJKLMNOP', 'aws-key'], ['-----BEGIN PRIVATE KEY-----', 'private-key'], ['https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz0123456789', 'discord-webhook']]) {
        const r = market.scanFiles([{ path: 'src/a.js', content }]);
        assert.equal(r.blocked, true, rule);
        assert.ok(rules([{ path: 'src/a.js', content }]).includes(rule), rule);
    }
    assert.equal(market.scanFiles([{ path: '.env', content: 'x' }]).blocked, true);
    assert.ok(!JSON.stringify(market.scanFiles([{ path: 'a.js', content: TOKEN }])).includes(TOKEN), 'findings never echo the secret');
});

test('static scan: eval, child_process, vm and obfuscation are flagged for review', () => {
    assert.ok(rules([{ path: 'a.js', content: 'eval(x)' }]).includes('eval'));
    assert.ok(rules([{ path: 'a.js', content: 'new Function("return 1")' }]).includes('eval'));
    assert.ok(rules([{ path: 'a.js', content: "require('child_process').exec('x')" }]).includes('child-process'));
    assert.ok(rules([{ path: 'bot.py', content: 'import subprocess\nsubprocess.run(["ls"])' }]).includes('child-process'));
    assert.ok(rules([{ path: 'bot.py', content: 'os.system("rm -rf /")' }]).includes('child-process'));
    assert.ok(rules([{ path: 'a.js', content: "require('vm')" }]).includes('vm'));
    assert.ok(rules([{ path: 'a.js', content: 'require(name)' }]).includes('dynamic-require'));
    assert.ok(rules([{ path: 'a.js', content: `"${'\\x41'.repeat(20)}"` }]).includes('obfuscation-escapes'));
    assert.ok(rules([{ path: 'a.js', content: 'String.fromCharCode(1,2,3,4,5,6,7,8,9,10)' }]).includes('obfuscation-charcode'));
    assert.ok(rules([{ path: 'a.js', content: `const b = "${'QUJD'.repeat(100)}"` }]).includes('obfuscation-blob'));
    assert.ok(rules([{ path: 'a.js', content: 'eval(atob(x))' }]).includes('obfuscation-decode-exec'));
    assert.ok(rules([{ path: 'a.js', content: 'Function(Buffer.from(x, "base64").toString())()' }]).includes('obfuscation-decode-exec'));
    assert.ok(rules([{ path: 'a.js', content: 'Function("return this")()' }]).includes('eval'));
    assert.ok(!rules([{ path: 'a.js', content: 'module.exports = myFunction(x); obj.Function(y);' }]).includes('eval'), 'no false positive on names ending in Function');
    assert.ok(rules([{ path: 'a.js', content: `x${'a'.repeat(1200)}` }]).includes('minified-line'));
    assert.equal(market.scanFiles([{ path: 'a.js', content: 'eval(x)' }]).blocked, false, 'review, not block');
});

test('generated projects scan clean (no false positives on our own templates)', () => {
    for (const framework of ['discordjs', 'discordjs-ts', 'discordpy']) {
        for (const template of ['blank', 'moderation', 'community', 'ai-assistant', 'ticket-support']) {
            const files = market.templateFiles(generateProject({ framework, template, name: 'Scan bot', botName: 'Scan bot' })).files;
            const r = market.scanFiles(files);
            assert.deepEqual(r.findings.filter((f) => f.severity === 'block'), [], `${framework}/${template}`);
        }
    }
});

test('templates: secrets never included; size limits; listing validation', () => {
    const t = market.templateFiles([{ path: 'src/index.js', content: 'x' }, { path: '.env', content: 'TOKEN=1' }, { path: 'id_rsa', content: 'k' }, { path: '.env.example', content: 'TOKEN=' }]);
    assert.deepEqual(t.files.map((f) => f.path).sort(), ['.env.example', 'src/index.js']);
    assert.ok(market.templateFiles([]).error);
    assert.ok(market.templateFiles(Array.from({ length: 11 }, (_, i) => ({ path: `f${i}.txt`, content: 'x'.repeat(500 * 1024) }))).error, '5 MB cap');
    assert.ok(market.validateListing({ name: 'Mod pack', description: 'Good moderation' }).value);
    assert.ok(market.validateListing({ name: 'x' }).errors.name);
    assert.ok(market.validateListing({ name: 'Free nitro', description: 'go to https://evil' }).errors.description);
    assert.ok(market.validateListing({ name: 'Ping all', description: '@everyone' }).errors.description);
});

test('review flow: publish → pending review; only admins approve/reject; owners unpublish', () => {
    assert.equal(market.nextStatus('pending_review', 'approve'), null, 'owners cannot approve their own');
    assert.equal(market.nextStatus('pending_review', 'approve', { isAdmin: true }), 'published');
    assert.equal(market.nextStatus('pending_review', 'reject', { isAdmin: true }), 'rejected');
    assert.equal(market.nextStatus('published', 'approve', { isAdmin: true }), null);
    assert.equal(market.nextStatus('published', 'unpublish'), 'unpublished');
    assert.equal(market.nextStatus('rejected', 'unpublish'), null);
    assert.equal(market.nextStatus('unpublished', 'publish'), null);
    const route = fs.readFileSync(path.join(API, 'route.js'), 'utf8');
    assert.match(route, /status: 'pending_review'/);
    assert.match(route, /scan\.blocked/);
    assert.ok(route.indexOf('scanFiles') < route.indexOf(".from('studio_templates').insert"), 'scan before insert');
});

test('install never executes code; plans enforced on the backend; payments BLOCKED', () => {
    const install = fs.readFileSync(path.join(API, '[templateId]', 'route.js'), 'utf8');
    const all = install + fs.readFileSync(path.join(API, 'route.js'), 'utf8') + fs.readFileSync(path.join(ROOT, 'dashboard', 'lib', 'studio', 'marketplace.js'), 'utf8').replace(/\/[^\n]*\/[gimsuy]*[,\]]/g, '');
    assert.doesNotMatch(install, /child_process|\beval\(|new Function|require\('vm'\)|npm install/);
    assert.match(install, /status !== 'published' && t\.owner_id !== ownerId/, 'only published (or own) templates install');
    assert.match(install, /validateNewProject/);
    assert.match(install, /isSuperAdmin/);
    assert.match(install, /writeAdminAudit/);
    assert.ok(all.length > 0);
    assert.deepEqual(Object.keys(market.PLAN_LIMITS), ['free', 'developer', 'premium']);
    assert.equal(market.limitsFor('free').projects, 3);
    assert.equal(market.limitsFor('nonsense').aiPerDay, 20, 'unknown plans fall back to Free');
    assert.ok(market.limitsFor('premium').aiPerDay > market.limitsFor('developer').aiPerDay);
    assert.equal(market.BILLING.status, 'blocked');
    const ai = fs.readFileSync(path.join(ROOT, 'dashboard', 'app', 'api', 'studio', 'projects', '[projectId]', 'ai', 'route.js'), 'utf8');
    assert.match(ai, /limitsFor\(await getPlan\(supabase, ownerId\)\)\.aiPerDay/);
    const sim = fs.readFileSync(path.join(ROOT, 'dashboard', 'app', 'api', 'studio', 'projects', '[projectId]', 'workflows', '[workflowId]', 'simulate', 'route.js'), 'utf8');
    assert.match(sim, /simulatorRunsPerDay/);
    const publish = fs.readFileSync(path.join(API, 'route.js'), 'utf8');
    assert.match(publish, /limitsFor\(plan\)\.templates/);
});
