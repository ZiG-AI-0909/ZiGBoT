// ZiGBoT Studio Phase 1: project rules, owner-only database access (IDOR),
// plan limits in the database, and separation from the ZiGBoT bot.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const studio = require('../dashboard/lib/studio/projects');

const ROOT = path.join(__dirname, '..');
const A = '00000000-0000-4000-8000-0000000000a1';
const B = '00000000-0000-4000-8000-0000000000b2';

// ------------------------------------------------------------------ rules
test('new project: valid wizard input becomes a clean row; owner_id never comes from the request', () => {
    const result = studio.validateNewProject({ name: '  My  Bot ', botName: 'Helper', description: 'Hi\nthere', visibility: 'private', framework: 'discordpy', template: 'moderation', owner_id: B });
    assert.deepEqual(result.value, { name: 'My Bot', bot_name: 'Helper', description: 'Hi there', visibility: 'private', framework: 'discordpy', language: 'python', template: 'moderation' });
    assert.equal(result.value.owner_id, undefined);
});

test('new project: bad names, unknown frameworks/templates and a mismatched language are refused', () => {
    const errors = (input) => Object.keys(studio.validateNewProject({ name: 'Good name', botName: 'Bot', framework: 'discordjs', template: 'blank', ...input }).errors || {});
    assert.deepEqual(errors({ name: 'ab' }), ['name']);
    assert.deepEqual(errors({ name: '../etc' }), ['name']);
    assert.deepEqual(errors({ name: '<script>' }), ['name']);
    assert.deepEqual(errors({ botName: 'x' }), ['botName']);
    assert.deepEqual(errors({ botName: 'Discord Helper' }), ['botName'], 'Discord forbids "discord" in bot names');
    assert.deepEqual(errors({ framework: 'pycord' }), ['framework'], 'only frameworks with a generator are offered');
    assert.deepEqual(errors({ template: 'music' }), ['template']);
    assert.deepEqual(errors({ language: 'python' }), ['language']);
    assert.deepEqual(errors({ visibility: 'public' }), ['visibility']);
});

test('the wizard has the 5 steps; frameworks and templates are the ones with generators', () => {
    assert.deepEqual(studio.WIZARD_STEPS.map((s) => s.id), ['identity', 'framework', 'template', 'discord', 'create']);
    assert.deepEqual(studio.FRAMEWORKS.map((f) => f.id), ['discordjs', 'discordjs-ts', 'discordpy']);
    assert.deepEqual(studio.TEMPLATES.map((t) => t.id), ['blank', 'moderation', 'community', 'ai-assistant', 'ticket-support']);
    assert.deepEqual([studio.planLimit('free'), studio.planLimit('developer'), studio.planLimit('premium'), studio.planLimit('nonsense')], [3, 20, 100, 3]);
});

test('patches: only name, description, status and visibility can change', () => {
    assert.deepEqual(studio.validateProjectPatch({ status: 'archived' }).value, { status: 'archived' });
    assert.deepEqual(studio.validateProjectPatch({ name: 'New name' }).value, { name: 'New name' });
    assert.match(studio.validateProjectPatch({ owner_id: B }).errors._, /cannot be changed/);
    assert.match(studio.validateProjectPatch({ framework: 'discordpy' }).errors._, /cannot be changed/);
    assert.ok(studio.validateProjectPatch({ status: 'deleted' }).errors.status);
    assert.match(studio.validateProjectPatch({}).errors._, /Nothing to change/);
});

test('duplicate names: "copy", then numbered, within 40 characters', () => {
    assert.equal(studio.copyName('Bot', ['Bot']), 'Bot copy');
    assert.equal(studio.copyName('Bot', ['Bot', 'bot copy']), 'Bot copy 2');
    assert.ok(studio.copyName('x'.repeat(40), []).length <= 40);
});

test('the project view never exposes the owner id or stored settings', () => {
    const view = studio.projectView({ id: '1', owner_id: A, name: 'n', bot_name: 'b', settings: { token: 'x' }, description: '', visibility: 'private', language: 'python', framework: 'discordpy', template: 'blank', status: 'active' });
    assert.equal(view.owner_id, undefined);
    assert.equal(view.ownerId, undefined);
    assert.equal(view.settings, undefined);
});

// ------------------------------------------------------- database (PGlite)
let db;
async function as(userId) {
    await db.exec('reset role');
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [userId || '']);
    await db.exec(userId ? 'set role authenticated' : 'set role anon');
}
async function asService() {
    await db.exec('reset role');
    await db.query("select set_config('request.jwt.claim.sub', '', false)");
    await db.exec('set role service_role');
}
const insertProject = (owner, name) => db.query(
    "insert into public.studio_projects (owner_id, name, bot_name, language, framework, template) values ($1, $2, 'Bot', 'javascript', 'discordjs', 'blank') returning id",
    [owner, name]
);

test.before(async () => {
    const { PGlite } = await import('@electric-sql/pglite');
    db = new PGlite();
    await db.exec(`
        create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
        create schema auth; create table auth.users (id uuid primary key);
        create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
        create schema storage;
        create table storage.buckets (id text primary key, name text not null, public boolean default false, file_size_limit bigint, allowed_mime_types text[]);
        grant usage on schema auth to anon, authenticated, service_role;
        grant usage on schema public to anon, authenticated, service_role;
        alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
        alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
        alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
    `);
    const dir = path.join(ROOT, 'supabase', 'migrations');
    const sql = fs.readdirSync(dir).filter((n) => n.endsWith('.sql')).sort().map((n) => fs.readFileSync(path.join(dir, n), 'utf8')).join('\n');
    await db.exec(sql);
    await db.exec(sql); // re-runnable
    await db.exec(`insert into auth.users (id) values ('${A}'), ('${B}')`);
});

test('IDOR: user B cannot read, change or delete user A\'s project; anon sees nothing', async () => {
    await as(A);
    const { rows: [{ id }] } = await insertProject(A, 'Alpha bot');
    await as(B);
    assert.equal((await db.query('select * from public.studio_projects where id = $1', [id])).rows.length, 0);
    assert.equal((await db.query("update public.studio_projects set name = 'Hacked' where id = $1 returning id", [id])).rows.length, 0);
    assert.equal((await db.query('delete from public.studio_projects where id = $1 returning id', [id])).rows.length, 0);
    await assert.rejects(insertProject(A, 'Planted by B'), /row-level security/, 'B cannot create a project owned by A');
    await as(null);
    await assert.rejects(db.query('select * from public.studio_projects'), /permission denied/);
    await as(A);
    assert.equal((await db.query('select name from public.studio_projects where id = $1', [id])).rows[0].name, 'Alpha bot', 'untouched');
});

test('a user cannot move their project to someone else', async () => {
    await as(A);
    const { rows: [{ id }] } = await db.query("select id from public.studio_projects where name = 'Alpha bot'");
    await assert.rejects(db.query('update public.studio_projects set owner_id = $1 where id = $2', [B, id]), /row-level security/);
});

test('plans: free allows 3 projects (archived ones count), the limit is enforced in the database, users cannot raise their own plan', async () => {
    await as(A);
    await insertProject(A, 'Beta bot');
    await db.query("update public.studio_projects set status = 'archived' where name = 'Beta bot'");
    await insertProject(A, 'Gamma bot');
    await assert.rejects(insertProject(A, 'Delta bot'), /studio_project_limit/);
    await assert.rejects(insertProject(A, 'alpha BOT'), /studio_project_limit|duplicate key/);
    await assert.rejects(db.query("insert into public.studio_accounts (user_id, plan) values ($1, 'premium')", [A]), /permission denied|row-level security/);
    await asService();
    await db.query("insert into public.studio_accounts (user_id, plan) values ($1, 'developer') on conflict (user_id) do update set plan = 'developer'", [A]);
    await as(A);
    await insertProject(A, 'Delta bot');
    assert.equal((await db.query('select plan from public.studio_accounts')).rows[0].plan, 'developer', 'users can read their own plan');
    await as(B);
    assert.equal((await db.query('select * from public.studio_accounts')).rows.length, 0, 'but not anyone else\'s');
});

test('framework and language must match in the database too', async () => {
    await as(B);
    await assert.rejects(db.query("insert into public.studio_projects (owner_id, name, bot_name, language, framework, template) values ($1, 'Mixed', 'Bot', 'python', 'discordjs', 'blank')", [B]), /check constraint/);
});

// --------------------------------------------------------------- static
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

test('every Studio API route uses the existing login and filters by the session owner', () => {
    const api = path.join(ROOT, 'dashboard', 'app', 'api', 'studio');
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name === 'route.js' ? [path.join(dir, e.name)] : []));
    const routes = walk(api);
    assert.ok(routes.length >= 3);
    for (const file of routes) {
        const src = fs.readFileSync(file, 'utf8');
        assert.match(src, /requireStudioUser\(\)/, file);
        assert.match(src, /export const (GET|POST|PATCH|DELETE) = handler\(/, `${file} uses the shared handler (same-origin check on writes)`);
        if (/\.from\('studio_projects'\)/.test(src)) assert.match(src, /\.eq\('owner_id', ownerId\)|getOwnedProject|owner_id: ownerId/, file);
    }
    assert.match(read('dashboard', 'lib', 'studio', 'server.js'), /\.eq\('id', id\)\.eq\('owner_id', ownerId\)/);
    assert.match(read('dashboard', 'middleware.js'), /'\/api\/studio\/:path\*'/);
});

test('ZiGBoT and Studio stay separate: nothing in src/ imports Studio code', () => {
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.js') ? [path.join(dir, e.name)] : []));
    // Imports only ("YouTube Studio" in a help text is not Studio code).
    for (const file of walk(path.join(ROOT, 'src'))) assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /require\([^)]*studio[^)]*\)|from\s+['"][^'"]*studio|studio_projects/i, file);
    assert.match(read('supabase', 'migrations', '20261115000000_studio_projects.sql'), /create table if not exists public\.studio_projects/);
});

// Phase 2 table: project files.
test('files: owner-only, cannot be planted in someone else\'s project, no traversal paths, 500 KB cap', async () => {
    await as(A);
    const { rows: [{ id }] } = await db.query("select id from public.studio_projects where name = 'Alpha bot'");
    await db.query("insert into public.studio_project_files (project_id, owner_id, path, content) values ($1, $2, 'src/index.js', 'x')", [id, A]);
    await as(B);
    assert.equal((await db.query('select * from public.studio_project_files where project_id = $1', [id])).rows.length, 0, 'B cannot read A\'s files');
    await assert.rejects(db.query("insert into public.studio_project_files (project_id, owner_id, path, content) values ($1, $2, 'evil.js', 'x')", [id, B]), /row-level security/, 'B cannot add a file to A\'s project');
    assert.equal((await db.query("update public.studio_project_files set content = 'hacked' where project_id = $1 returning id", [id])).rows.length, 0);
    await as(A);
    for (const bad of ['../etc/passwd', 'a/../../b', '/abs', 'a\b', 'has space.js']) {
        await assert.rejects(db.query('insert into public.studio_project_files (project_id, owner_id, path, content) values ($1, $2, $3, \'x\')', [id, A, bad]), /check constraint/, bad);
    }
    await assert.rejects(db.query("insert into public.studio_project_files (project_id, owner_id, path, content) values ($1, $2, 'big.txt', repeat('x', 512001))", [id, A]), /check constraint/);
    await db.query('delete from public.studio_projects where id = $1', [id]);
    assert.equal((await db.query('select count(*)::int as n from public.studio_project_files where project_id = $1', [id])).rows[0].n, 0, 'files go with the project');
});

// Phase 3 table: secrets are unreachable from browser sessions, even the owner's own.
test('secrets: no browser access at all; only the service role reads or writes them', async () => {
    await as(A);
    const { rows: [{ id }] } = await insertProject(A, 'Secret bot');
    await assert.rejects(db.query("insert into public.studio_secrets (project_id, owner_id, name, ciphertext, iv, tag, last4) values ($1, $2, 'DISCORD_TOKEN', 'aaaaaaaaaaaaaaaaaaaa', 'aaaaaaaaaaaaaaaa', 'aaaaaaaaaaaaaaaaaaaaaaaa', 'abcd')", [id, A]), /permission denied/);
    await asService();
    await db.query("insert into public.studio_secrets (project_id, owner_id, name, ciphertext, iv, tag, last4) values ($1, $2, 'DISCORD_TOKEN', 'aaaaaaaaaaaaaaaaaaaa', 'aaaaaaaaaaaaaaaa', 'aaaaaaaaaaaaaaaaaaaaaaaa', 'abcd')", [id, A]);
    await as(A);
    await assert.rejects(db.query('select * from public.studio_secrets'), /permission denied/, 'not even the owner can read ciphertext from the browser');
    await as(B);
    await assert.rejects(db.query('select * from public.studio_secrets'), /permission denied/);
    await asService();
    await assert.rejects(db.query("insert into public.studio_secrets (project_id, owner_id, name, ciphertext, iv, tag, last4) values ($1, $2, 'bad-name', 'aaaaaaaaaaaaaaaaaaaa', 'aaaaaaaaaaaaaaaa', 'aaaaaaaaaaaaaaaaaaaaaaaa', 'abcd')", [id, A]), /check constraint/);
    await db.query('delete from public.studio_projects where id = $1', [id]);
});

// Phase 4 table: version history is owner-only and keeps 50 per project.
test('versions: owner-only RLS and pruned to the newest 50 per project', async () => {
    await as(A);
    const { rows: [{ id }] } = await insertProject(A, 'History bot');
    for (let i = 0; i < 55; i += 1) await db.query("insert into public.studio_file_versions (project_id, owner_id, path, content) values ($1, $2, 'src/index.js', $3)", [id, A, `v${i}`]);
    const { rows } = await db.query('select content from public.studio_file_versions where project_id = $1 order by id', [id]);
    assert.equal(rows.length, 50);
    assert.equal(rows[0].content, 'v5', 'the oldest ones were dropped');
    await assert.rejects(db.query("insert into public.studio_file_versions (project_id, owner_id, path, content) values ($1, $2, '../x', 'x')", [id, A]), /check constraint/);
    await as(B);
    assert.equal((await db.query('select * from public.studio_file_versions where project_id = $1', [id])).rows.length, 0, 'B cannot read A\'s history');
    await assert.rejects(db.query("insert into public.studio_file_versions (project_id, owner_id, path, content) values ($1, $2, 'a.js', 'x')", [id, B]), /row-level security/);
    await as(A);
    await db.query('delete from public.studio_projects where id = $1', [id]);
});

// Phase 5 tables: workflows and runs are owner-only; 20 workflows per project.
test('workflows: owner-only RLS, run history owner-only, 20 per project', async () => {
    await as(A);
    const { rows: [{ id }] } = await insertProject(A, 'Flow bot');
    const { rows: [{ id: wfId }] } = await db.query("insert into public.studio_workflows (project_id, owner_id, name) values ($1, $2, 'Greeter') returning id", [id, A]);
    await db.query('insert into public.studio_workflow_runs (workflow_id, project_id, owner_id, ok) values ($1, $2, $3, true)', [wfId, id, A]);
    await as(B);
    assert.equal((await db.query('select * from public.studio_workflows where project_id = $1', [id])).rows.length, 0);
    assert.equal((await db.query('select * from public.studio_workflow_runs where workflow_id = $1', [wfId])).rows.length, 0);
    assert.equal((await db.query("update public.studio_workflows set name = 'hacked' where id = $1 returning id", [wfId])).rows.length, 0);
    await assert.rejects(db.query("insert into public.studio_workflows (project_id, owner_id, name) values ($1, $2, 'evil')", [id, B]), /row-level security/);
    await assert.rejects(db.query('insert into public.studio_workflow_runs (workflow_id, project_id, owner_id, ok) values ($1, $2, $3, true)', [wfId, id, B]), /row-level security/);
    await as(A);
    for (let i = 0; i < 19; i += 1) await db.query('insert into public.studio_workflows (project_id, owner_id, name) values ($1, $2, $3)', [id, A, `w${i}`]);
    await assert.rejects(db.query("insert into public.studio_workflows (project_id, owner_id, name) values ($1, $2, 'one too many')", [id, A]), /studio_workflow_limit/);
    for (let i = 0; i < 22; i += 1) await db.query('insert into public.studio_workflow_runs (workflow_id, project_id, owner_id, ok) values ($1, $2, $3, true)', [wfId, id, A]);
    assert.equal((await db.query('select count(*)::int as n from public.studio_workflow_runs where workflow_id = $1', [wfId])).rows[0].n, 20);
    await db.query('delete from public.studio_projects where id = $1', [id]);
});

// Phase 6 tables: proposals and AI usage are owner-only.
test('ai: proposals and usage are owner-only; proposals pruned to 30 per project', async () => {
    await as(A);
    const { rows: [{ id }] } = await insertProject(A, 'AI bot');
    await db.query("insert into public.studio_ai_proposals (project_id, owner_id, request) values ($1, $2, 'add ping')", [id, A]);
    await db.query('insert into public.studio_ai_usage (owner_id, project_id) values ($1, $2)', [A, id]);
    await as(B);
    assert.equal((await db.query('select * from public.studio_ai_proposals where project_id = $1', [id])).rows.length, 0);
    assert.equal((await db.query('select * from public.studio_ai_usage where owner_id = $1', [A])).rows.length, 0);
    assert.equal((await db.query("update public.studio_ai_proposals set status = 'approved' where project_id = $1 returning id", [id])).rows.length, 0, 'B cannot approve A\'s proposal');
    await assert.rejects(db.query("insert into public.studio_ai_proposals (project_id, owner_id, request) values ($1, $2, 'evil')", [id, B]), /row-level security/);
    await assert.rejects(db.query('insert into public.studio_ai_usage (owner_id) values ($1)', [A]), /row-level security/, 'cannot burn someone else\'s quota');
    await as(A);
    await assert.rejects(db.query("insert into public.studio_ai_proposals (project_id, owner_id, request, status) values ($1, $2, 'x', 'deployed')", [id, A]), /check constraint/);
    for (let i = 0; i < 31; i += 1) await db.query('insert into public.studio_ai_proposals (project_id, owner_id, request) values ($1, $2, $3)', [id, A, `r${i}`]);
    assert.equal((await db.query('select count(*)::int as n from public.studio_ai_proposals where project_id = $1', [id])).rows[0].n, 30);
    await db.query('delete from public.studio_projects where id = $1', [id]);
});

// Phase 7 table: deployment history is readable by the owner only, written by the server only.
test('deployments: owner reads (not the stored files), only the service role writes', async () => {
    await as(A);
    const { rows: [{ id }] } = await insertProject(A, 'Deploy bot');
    await assert.rejects(db.query("insert into public.studio_deployments (project_id, owner_id, version, status, provider) values ($1, $2, 1, 'live', 'mock')", [id, A]), /permission denied/);
    await asService();
    await db.query("insert into public.studio_deployments (project_id, owner_id, version, status, provider, files) values ($1, $2, 1, 'live', 'mock', '[]')", [id, A]);
    await as(A);
    assert.equal((await db.query('select id, version, status from public.studio_deployments where project_id = $1', [id])).rows.length, 1);
    await assert.rejects(db.query('select files from public.studio_deployments'), /permission denied/);
    await assert.rejects(db.query("update public.studio_deployments set status = 'stopped'"), /permission denied/);
    await as(B);
    assert.equal((await db.query('select id from public.studio_deployments where project_id = $1', [id])).rows.length, 0);
    await as(A);
    await db.query('delete from public.studio_projects where id = $1', [id]);
});

// Phase 8 table: templates are visible when published or owned; only the server writes them.
test('templates: published or own only; browsers cannot write or change status; install counter server-only', async () => {
    await asService();
    await db.query("insert into public.studio_templates (owner_id, name, framework, base_template, files, status) values ($1, 'Pending pack', 'discordjs', 'blank', '[]', 'pending_review'), ($1, 'Live pack', 'discordjs', 'blank', '[]', 'published')", [A]);
    await as(B);
    assert.deepEqual((await db.query('select name from public.studio_templates order by name')).rows.map((r) => r.name), ['Live pack'], 'others see only published');
    await assert.rejects(db.query("insert into public.studio_templates (owner_id, name, framework, base_template, files, status) values ($1, 'Sneaky', 'discordjs', 'blank', '[]', 'published')", [B]), /permission denied/);
    await assert.rejects(db.query("update public.studio_templates set status = 'published'"), /permission denied/);
    await assert.rejects(db.query("select public.studio_count_install(id) from public.studio_templates limit 1"), /permission denied/);
    await as(A);
    assert.equal((await db.query('select name from public.studio_templates')).rows.length, 2, 'owners see their pending ones');
    await asService();
    await assert.rejects(db.query("insert into public.studio_templates (owner_id, name, framework, base_template, files, status) values ($1, 'Bad', 'discordjs', 'blank', '[]', 'live')", [A]), /check constraint/);
    await db.query('delete from public.studio_templates where owner_id = $1', [A]);
    await as(A);
});

// Platform Phase 3: browsers can edit drafts but cannot activate workflows or extend plans.
test('automation premium: activation columns and plan expiry are server-only', async () => {
    await as(A);
    const { rows: [{ id }] } = await insertProject(A, 'Paywall bot');
    const { rows: [{ id: wfId }] } = await db.query("insert into public.studio_workflows (project_id, owner_id, name) values ($1, $2, 'Draft') returning id", [id, A]);
    await db.query("update public.studio_workflows set name = 'Renamed', graph = '{\"version\":1,\"nodes\":[],\"edges\":[]}' where id = $1", [wfId]);
    await assert.rejects(db.query('update public.studio_workflows set active = true where id = $1', [wfId]), /permission denied/, 'owner cannot self-activate');
    await assert.rejects(db.query("insert into public.studio_workflows (project_id, owner_id, name, active) values ($1, $2, 'x', true)", [id, A]), /permission denied/);
    await assert.rejects(db.query("update public.studio_accounts set plan_expires_at = now() + interval '1 year'"), /permission denied/);
    await asService();
    await db.query('update public.studio_workflows set active = true, activated_at = now() where id = $1', [wfId]);
    await as(A);
    assert.equal((await db.query('select active from public.studio_workflows where id = $1', [wfId])).rows[0].active, true);
    await db.query('delete from public.studio_projects where id = $1', [id]);
});

// Self-hosted runners: owners read their runners, commands and logs, never the hashes; only the server writes.
test('runners: owner-only reads, no hash columns, no browser writes', async () => {
    await as(A);
    const { rows: [{ id }] } = await insertProject(A, 'Runner bot');
    await assert.rejects(db.query("insert into public.studio_runners (project_id, owner_id, name) values ($1, $2, 'vps')", [id, A]), /permission denied/);
    await asService();
    const { rows: [{ id: runnerId }] } = await db.query("insert into public.studio_runners (project_id, owner_id, name, status, token_hash) values ($1, $2, 'vps', 'paired', repeat('a', 64)) returning id", [id, A]);
    await db.query("insert into public.studio_runner_commands (runner_id, project_id, owner_id, action) values ($1, $2, $3, 'deploy')", [runnerId, id, A]);
    await assert.rejects(db.query("insert into public.studio_runner_commands (runner_id, project_id, owner_id, action) values ($1, $2, $3, 'rm -rf')", [runnerId, id, A]), /check constraint/);
    await as(A);
    assert.equal((await db.query('select id, name, state from public.studio_runners where project_id = $1', [id])).rows.length, 1);
    await assert.rejects(db.query('select token_hash from public.studio_runners'), /permission denied/);
    await assert.rejects(db.query("insert into public.studio_runner_commands (runner_id, project_id, owner_id, action) values ($1, $2, $3, 'start')", [runnerId, id, A]), /permission denied/);
    assert.equal((await db.query('select * from public.studio_runner_commands where runner_id = $1', [runnerId])).rows.length, 1);
    await as(B);
    assert.equal((await db.query('select id from public.studio_runners where project_id = $1', [id])).rows.length, 0);
    assert.equal((await db.query('select id from public.studio_runner_commands where runner_id = $1', [runnerId])).rows.length, 0);
    await as(A);
    await db.query('delete from public.studio_projects where id = $1', [id]);
});
