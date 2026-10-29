const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const stats = require('../dashboard/lib/shared/adminStats');
const purchases = require('../dashboard/lib/shared/purchases');

// Super Admin (/admin). The dashboard's server modules are ESM and need a
// live Supabase session, so access control is checked in their source here
// (every page and route guards itself) and the database rules in real
// Postgres; the numbers are checked through the pure aggregation module.

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\r\n/g, '\n');
const walk = (dir) => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));

test('access: only server-configured Discord IDs, and nobody when none is configured', () => {
    const env = read('dashboard/lib/env.js');
    assert.match(env, /get superAdminDiscordIds\(\) \{\n\s+const raw = process\.env\.SUPER_ADMIN_DISCORD_IDS \|\| process\.env\.BOT_CREATOR_ID \|\| '';\n\s+return \[\.\.\.new Set\(raw\.split\(','\)\.map\(\(s\) => s\.trim\(\)\)\.filter\(\(s\) => \/\^\\d\{17,20\}\$\/\.test\(s\)\)\)\];/);
    const admin = read('dashboard/lib/admin.js');
    assert.match(admin, /return ids\.length > 0 && ids\.includes\(String\(discordId \|\| ''\)\);/, 'fails closed with no IDs');
    assert.match(admin, /const current = await getCurrentUser\(\)\.catch\(\(\) => null\);\n\s+if \(!current \|\| !isSuperAdmin\(current\.discordId\)\) return null;/, 'identity comes from the verified Supabase session');
    assert.match(admin, /if \(!admin\) throw new HttpError\(404, 'Not found\.'\);/, 'others see a 404, as if /admin did not exist');
    // Nothing in the database can make someone an admin.
    const migrations = walk('supabase/migrations').map(read).join('\n');
    // No column that could flag an account as admin (comments may mention the env var).
    assert.doesNotMatch(migrations, /\b(is_admin|is_super_admin|super_admin|admin_role)\s+(boolean|text|integer)/i);
    const identityPart = admin.slice(0, admin.indexOf('export function adminRateLimit'));
    assert.doesNotMatch(identityPart, /\.from\(/, 'the admin check never reads a table');
});

test('every /admin page and the layout guard themselves before loading data', () => {
    const pages = walk('dashboard/app/admin').filter((f) => /[\\/](page|layout)\.js$/.test(f));
    assert.ok(pages.length >= 11, `found ${pages.length}`);
    for (const file of pages) {
        const code = read(file);
        const body = code.slice(code.indexOf('export default async function'));
        const guard = body.search(/await getSuperAdmin\(\)/);
        const notFound = body.search(/notFound\(\)/);
        const firstLoad = body.search(/await load|loadAudit|adminConfig\(/);
        assert.ok(guard > 0 && notFound > guard, `${file} checks the Super Admin`);
        if (firstLoad > 0) assert.ok(guard < firstLoad, `${file} checks before loading data`);
    }
    assert.match(read('dashboard/app/admin/layout.js'), /robots: \{ index: false, follow: false \}/);
});

test('every /api/admin route requires the Super Admin; actions are rate-limited and audit-logged', () => {
    const routes = walk('dashboard/app/api/admin').filter((f) => f.endsWith('route.js'));
    assert.equal(routes.length, 3);
    for (const file of routes) {
        const code = read(file);
        for (const verb of code.match(/export const (GET|POST|PATCH|DELETE|PUT) = handler\(async/g)) {
            const body = code.slice(code.indexOf(verb));
            assert.match(body.slice(0, 200), /const admin = await requireSuperAdmin\(\);\n\s+adminRateLimit\(admin\.discordId/, `${file} ${verb}`);
        }
        assert.match(code, /await writeAdminAudit\(admin, \{/, `${file} is audit-logged`);
        assert.doesNotMatch(code, /DELETE|\.delete\(/, `${file}: nothing is deleted from /admin`);
    }
    // Writes go through the same-origin (CSRF) check of the shared handler.
    assert.match(read('dashboard/lib/http.js'), /if \(!\['GET', 'HEAD'\]\.includes\(request\.method\)\) \{\n\s+const ok = isSameOrigin/);
});

test('feedback review never edits the customer\'s answers, and the private note stays private', () => {
    const route = read('dashboard/app/api/admin/feedback/[responseId]/route.js');
    const changes = [...route.matchAll(/changes\.(\w+) =/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(changes)].sort(), ['admin_note', 'archived_at', 'review_status', 'reviewed_at']);
    assert.match(route, /metadata: \{ fields: [^}]*\}/);
    assert.doesNotMatch(route.slice(route.indexOf('writeAdminAudit')), /admin_note: /, 'the note text is not copied into the audit log');
    const exporter = read('dashboard/app/api/admin/export/route.js');
    assert.doesNotMatch(exporter.slice(exporter.indexOf('FEEDBACK_COLUMNS'), exporter.indexOf('PURCHASE_COLUMNS')), /admin_note/, 'CSV export leaves the note out');
    // The customer-facing API returns only what the form needs.
    assert.deepEqual(Object.keys(purchases).sort(), ['FeedbackError', 'loadPendingFeedback', 'planPeriodOf', 'recordVerifiedPurchase', 'remindLater', 'submitFeedback']);
    assert.match(read('dashboard/lib/shared/purchases.js'), /return \{\n\s+purchaseId: purchase\.id,\n\s+planPeriod: purchase\.plan_period,\n\s+planLabel: planLabel\(purchase\),\n\s+snoozedUntil:/);
    // No public page links to /admin.
    for (const file of walk('dashboard/components').filter((f) => !f.includes(`${path.sep}admin${path.sep}`))) {
        assert.doesNotMatch(read(file), /href="\/admin/, `${file} links to /admin`);
    }
});

test('the admin audit log is append-only, even for the service role; browsers get nothing', async () => {
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
    const migrations = walk('supabase/migrations').filter((f) => f.endsWith('.sql')).sort().map(read).join('\n');
    await db.exec(migrations);
    await db.exec(migrations);
    await db.exec('set role service_role');
    await db.query("insert into public.zb_admin_audit_log (admin_discord_id, action, target_type, target_id) values ('100000000000000001', 'feedback.update', 'feedback', 'x')");
    await assert.rejects(db.query("update public.zb_admin_audit_log set action = 'nothing'"), /permission denied|append-only/);
    await assert.rejects(db.query('delete from public.zb_admin_audit_log'), /permission denied|append-only/);
    await assert.rejects(db.query('truncate public.zb_admin_audit_log'), /permission denied/);
    // Even a role that could update meets the trigger.
    await db.exec('reset role');
    await assert.rejects(db.query("update public.zb_admin_audit_log set action = 'nothing'"), /append-only/);
    for (const role of ['authenticated', 'anon']) {
        await db.exec(`reset role; set role ${role}`);
        await assert.rejects(db.query('select * from public.zb_admin_audit_log'), /permission denied/);
        await assert.rejects(db.query("insert into public.zb_admin_audit_log (action) values ('forged')"), /permission denied/);
    }
    await db.close();
});

// ---------- numbers ----------

const fb = (plan, rating, ease, recommend, extra = {}) => ({ id: `${plan}-${rating}-${recommend}`, plan_period: plan, overall_rating: rating, activation_ease: ease, recommend_score: recommend, value_for_money: 'good', review_status: 'new', archived_at: null, valuable_features: [], issues: [], purchase_reasons: [], ...extra });

test('feedback statistics reflect exactly the stored responses', () => {
    const rows = [
        fb('monthly', 5, 5, 10, { valuable_features: ['anti_nuke', 'memory'], issues: ['none'], comments: 'great' }),
        fb('monthly', 3, 4, 6, { valuable_features: ['anti_nuke'], issues: ['performance'], value_for_money: 'fair', review_status: 'reviewed' }),
        fb('yearly', 4, 2, 9, { valuable_features: ['music_voice'], issues: ['performance', 'not_working'], value_for_money: 'too_expensive', archived_at: '2026-10-30T00:00:00Z' })
    ];
    const s = stats.feedbackStats(rows);
    assert.equal(s.total, 3);
    assert.equal(s.new, 1, 'archived responses are not "new"');
    assert.equal(s.reviewed, 1);
    assert.equal(s.archived, 1);
    assert.equal(s.all.avgRating, 4);
    assert.equal(s.monthly.avgRating, 4);
    assert.equal(s.yearly.avgEase, 2);
    assert.equal(s.monthly.count, 2);
    // Scores 10, 6, 9: two promoters (9-10), one detractor (0-6) → (2-1)/3.
    assert.equal(s.all.nps, 33);
    assert.equal(s.monthly.nps, 0);
    assert.deepEqual(s.features.map((f) => [f.key, f.count]), [['anti_nuke', 2], ['memory', 1], ['music_voice', 1]]);
    assert.deepEqual(s.issues.map((i) => [i.key, i.count]), [['performance', 2], ['not_working', 1]], '"No issues" is not a problem');
    assert.deepEqual(s.yearly.value.too_expensive, 1);
    assert.deepEqual(s.ratingDistribution.map((d) => d.value), [0, 0, 1, 1, 1]);
    assert.equal(s.suggestions.length, 1);
    // Empty input: no invented averages.
    const empty = stats.feedbackStats([]);
    assert.equal(empty.all.avgRating, null);
    assert.equal(empty.all.nps, null);
});

test('monthly series bucket by calendar month and ignore anything outside the window', () => {
    const now = Date.parse('2026-10-29T12:00:00Z');
    const series = stats.monthlySeries([
        { at: '2026-10-01T00:00:00Z' }, { at: '2026-10-28T23:59:00Z' }, { at: '2026-09-15T00:00:00Z' }, { at: '2025-01-01T00:00:00Z' }, { at: null }
    ], { date: (r) => r.at, months: 3, now });
    assert.deepEqual(series.map((m) => [m.key, m.value]), [['2026-08', 0], ['2026-09', 1], ['2026-10', 2]]);
    assert.equal(series[2].label, 'Oct 2026');
});

test('revenue counts only captured money, minus refunds; pending and failed are never revenue', () => {
    const s = stats.paymentsSummary([
        { status: 'captured', amount: 39900, currency: 'INR' },
        { status: 'captured', amount: 399900 },
        { status: 'refunded', amount: 39900, amount_refunded: 39900 },
        { status: 'captured', amount: 39900, amount_refunded: 10000 },
        { status: 'authorized', amount: 39900 },
        { status: 'failed', amount: 399900 },
        { status: 'created', amount: 39900 }
    ]);
    assert.equal(s.grossPaise, 39900 + 399900 + 39900 + 39900);
    assert.equal(s.refundedPaise, 49900);
    assert.equal(s.collectedPaise, 39900 + 399900 + 39900 + 39900 - 49900);
    assert.equal(s.pendingCount, 2);
    assert.equal(s.pendingPaise, 79800);
    assert.equal(s.failedCount, 1);
    assert.equal(stats.formatMoney(399900), '₹3,999');
    assert.equal(stats.formatMoney(null), '—');
    assert.equal(stats.paymentsSummary([]).collectedPaise, 0);
});

test('CSV export escapes text and defuses spreadsheet formulas', () => {
    const csv = stats.toCsv([
        { a: '=HYPERLINK("http://evil")', b: 'plain', c: ['x', 'y'] },
        { a: 'line\nbreak, comma', b: '"quoted"', c: null },
        { a: '+1', b: '-2', c: '@cmd' }
    ], [{ label: 'A', get: (r) => r.a }, { label: 'B', get: (r) => r.b }, { label: 'C', get: (r) => r.c }]);
    assert.equal(csv, [
        'A,B,C',
        `"'=HYPERLINK(""http://evil"")",plain,x; y`,
        '"line\nbreak, comma","""quoted""",',
        "'+1,'-2,'@cmd",
        ''
    ].join('\r\n'));
});
