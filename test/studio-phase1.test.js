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
