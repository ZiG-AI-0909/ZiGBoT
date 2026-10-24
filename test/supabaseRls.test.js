/**
 * Runs the real Supabase migration inside PGlite (Postgres 18 compiled to
 * WASM) with a minimal stub of Supabase's auth schema and roles, then checks
 * the RLS policies as different users. Supabase's default "grant all to
 * anon/authenticated" privileges are simulated first, so the test also
 * proves the migration's REVOKEs work.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Every migration, in filename (timestamp) order, exactly as Supabase applies them.
const MIGRATIONS_DIR = path.join(__dirname, '..', 'supabase', 'migrations');
const MIGRATION = fs.readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8'))
    .join('\n');

const A = '00000000-0000-4000-8000-00000000000a'; // admin of G1
const B = '00000000-0000-4000-8000-00000000000b'; // admin of G2
const C = '00000000-0000-4000-8000-00000000000c'; // verification expired for G1
const G1 = '111111111111111111';
const G2 = '222222222222222222';

let db;

async function as(userId) {
    await db.exec('reset role');
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [userId || '']);
    await db.query("select set_config('request.jwt.claim.role', $1, false)", [userId ? 'authenticated' : 'anon']);
    await db.exec(userId ? 'set role authenticated' : 'set role anon');
}

async function asService() {
    await db.exec('reset role');
    await db.query("select set_config('request.jwt.claim.sub', '', false)");
    await db.query("select set_config('request.jwt.claim.role', 'service_role', false)");
    await db.exec('set role service_role');
}

async function rejects(sql, params, pattern) {
    await assert.rejects(() => db.query(sql, params), pattern);
}

test.before(async () => {
    const { PGlite } = await import('@electric-sql/pglite');
    db = new PGlite();
    await db.exec(`
        create role anon nologin;
        create role authenticated nologin;
        create role service_role nologin bypassrls;
        create schema auth;
        create table auth.users (id uuid primary key);
        create function auth.uid() returns uuid language sql stable as
            $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
        create schema storage;
        create table storage.buckets (id text primary key, name text not null, public boolean default false, file_size_limit bigint, allowed_mime_types text[]);
        grant usage on schema auth to anon, authenticated, service_role;
        grant usage on schema public to anon, authenticated, service_role;
        alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
        alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
        alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
    `);
    await db.exec(MIGRATION);
    // Re-running must be harmless (idempotent migration).
    await db.exec(MIGRATION);

    await db.exec(`
        insert into auth.users (id) values ('${A}'), ('${B}'), ('${C}');
    `);
    await asService();
    await db.exec(`
        insert into public.zb_guilds (guild_id, name, bot_installed) values ('${G1}', 'Guild One', true), ('${G2}', 'Guild Two', true);
        insert into public.zb_guild_configs (guild_id, custom_system_prompt) values ('${G1}', 'G1 prompt'), ('${G2}', 'G2 prompt');
        insert into public.zb_role_mappings (guild_id, role_id, tier) values ('${G2}', '222222222222222299', 'moderator');
        insert into public.zb_guild_admins (user_id, guild_id, discord_user_id) values
            ('${A}', '${G1}', '100000000000000001'),
            ('${B}', '${G2}', '100000000000000002');
        insert into public.zb_guild_admins (user_id, guild_id, discord_user_id, verified_at) values
            ('${C}', '${G1}', '100000000000000003', now() - interval '20 minutes');
        insert into public.zb_profiles (user_id, discord_user_id, username) values
            ('${A}', '100000000000000001', 'alice'), ('${B}', '100000000000000002', 'bob');
        insert into public.zb_user_guilds (user_id, guild_id, can_manage) values ('${A}', '${G1}', true), ('${B}', '${G2}', true);
        insert into public.zb_guild_subscriptions (guild_id, subscription_id, plan_period, status) values
            ('${G1}', 'sub_G1Subscription01', 'monthly', 'active'),
            ('${G2}', 'sub_G2Subscription02', 'yearly', 'active');
    `);
});

test.after(async () => {
    await db?.close();
});

test('RLS: an admin only sees their own verified server', async () => {
    await as(A);
    const configs = await db.query('select guild_id from public.zb_guild_configs order by guild_id');
    assert.deepEqual(configs.rows.map((r) => r.guild_id), [G1]);
    const mappings = await db.query('select guild_id from public.zb_role_mappings');
    assert.equal(mappings.rows.length, 0, "cannot see G2's role mappings");
    const guilds = await db.query('select guild_id from public.zb_guilds');
    assert.deepEqual(guilds.rows.map((r) => r.guild_id), [G1]);
});

test('RLS: changing the server id in a request cannot touch another server', async () => {
    await as(A);
    const result = await db.query("update public.zb_guild_configs set custom_system_prompt = 'hacked' where guild_id = $1", [G2]);
    assert.equal(result.affectedRows, 0);
    await rejects("insert into public.zb_role_mappings (guild_id, role_id) values ($1, '222222222222222288')", [G2], /row-level security/);
    await rejects("insert into public.zb_guild_configs (guild_id) values ($1)", [G2], /row-level security|duplicate key/);
    await rejects('update public.zb_guild_configs set guild_id = $1 where guild_id = $2', [G2, G1], /immutable|row-level security/);
    await asService();
    const g2 = await db.query('select custom_system_prompt from public.zb_guild_configs where guild_id = $1', [G2]);
    assert.equal(g2.rows[0].custom_system_prompt, 'G2 prompt');
});

test('RLS: an admin can update their own server; version and updated_by are server-assigned', async () => {
    await as(A);
    const result = await db.query("update public.zb_guild_configs set custom_system_prompt = 'new G1', version = 999, updated_by = $1 where guild_id = $2 returning version, updated_by", [B, G1]);
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].version, 2, 'version is incremented by the trigger, not the client');
    assert.equal(result.rows[0].updated_by, A, 'updated_by cannot be spoofed');
    const inserted = await db.query("insert into public.zb_role_mappings (guild_id, role_id, tier, allowed_features) values ($1, '111111111111111199', 'moderator', '{moderation}') returning id", [G1]);
    assert.equal(inserted.rows.length, 1);
    await rejects("insert into public.zb_role_mappings (guild_id, role_id, allowed_features) values ($1, '111111111111111198', '{root}')", [G1], /check constraint/);
});

test('RLS: expired verification grants nothing', async () => {
    await as(C);
    const configs = await db.query('select * from public.zb_guild_configs');
    assert.equal(configs.rows.length, 0);
    const result = await db.query("update public.zb_guild_configs set server_rules = 'x' where guild_id = $1", [G1]);
    assert.equal(result.affectedRows, 0);
});

test('RLS: users cannot grant themselves admin or read other users', async () => {
    await as(C);
    await rejects("insert into public.zb_guild_admins (user_id, guild_id, discord_user_id) values ($1, $2, '100000000000000003')", [C, G2], /permission denied/);
    await rejects('update public.zb_guild_admins set verified_at = now() where user_id = $1', [C], /permission denied/);
    await as(A);
    const profiles = await db.query('select user_id from public.zb_profiles');
    assert.deepEqual(profiles.rows.map((r) => r.user_id), [A]);
    const userGuilds = await db.query('select guild_id from public.zb_user_guilds');
    assert.deepEqual(userGuilds.rows.map((r) => r.guild_id), [G1]);
    await rejects('delete from public.zb_guild_configs where guild_id = $1', [G1], /permission denied/);
    await rejects('insert into public.zb_guilds (guild_id) values ($1)', ['333333333333333333'], /permission denied/);
});

test('RLS: logged-out (anon) requests get nothing', async () => {
    await as(null);
    await rejects('select * from public.zb_guild_configs', [], /permission denied/);
    await rejects('select * from public.zb_role_mappings', [], /permission denied/);
    await rejects('select * from public.zb_bot_heartbeat', [], /permission denied/);
});

test('audit log records every change with the real actor and is admin-scoped, append-only', async () => {
    await as(A);
    const own = await db.query("select actor_user_id, action, table_name, (after->>'custom_system_prompt') as prompt from public.zb_config_audit_log where table_name = 'zb_guild_configs' and action = 'UPDATE'");
    assert.ok(own.rows.some((r) => r.actor_user_id === A && r.prompt === 'new G1'));
    const foreign = await db.query('select * from public.zb_config_audit_log where guild_id = $1', [G2]);
    assert.equal(foreign.rows.length, 0, "cannot read another server's audit log");
    await rejects('update public.zb_config_audit_log set action = $1', ['DELETE'], /permission denied/);
    await rejects('delete from public.zb_config_audit_log', [], /permission denied/);
});

test('preview usage can only be recorded for yourself on a server you manage', async () => {
    await as(A);
    await db.query('insert into public.zb_preview_usage (user_id, guild_id) values ($1, $2)', [A, G1]);
    await rejects('insert into public.zb_preview_usage (user_id, guild_id) values ($1, $2)', [A, G2], /row-level security/);
    await rejects('insert into public.zb_preview_usage (user_id, guild_id) values ($1, $2)', [B, G1], /row-level security/);
});

test('service role (bot worker / server routes) bypasses RLS', async () => {
    await asService();
    const all = await db.query('select guild_id from public.zb_guild_configs order by guild_id');
    assert.deepEqual(all.rows.map((r) => r.guild_id), [G1, G2]);
});

test('premium: admins read only their own server subscription and can never write one', async () => {
    await as(A);
    const own = await db.query('select guild_id, status from public.zb_guild_subscriptions');
    assert.deepEqual(own.rows.map((r) => r.guild_id), [G1], 'only the verified server is visible');
    await rejects("update public.zb_guild_subscriptions set status = 'active' where guild_id = $1", [G1], /permission denied/);
    await rejects("insert into public.zb_guild_subscriptions (guild_id, subscription_id, plan_period, status) values ($1, 'sub_FakePremium001', 'yearly', 'active')", [G2], /permission denied/);
    await rejects('delete from public.zb_guild_subscriptions', [], /permission denied/);

    await as(C); // verification expired
    assert.equal((await db.query('select * from public.zb_guild_subscriptions')).rows.length, 0);
    await as(null);
    await rejects('select * from public.zb_guild_subscriptions', [], /permission denied/);
});

test('premium: the database rejects malformed subscription rows even from the service role', async () => {
    await asService();
    await rejects("update public.zb_guild_subscriptions set subscription_id = 'not-an-id' where guild_id = $1", [G1], /check constraint/);
    await rejects("update public.zb_guild_subscriptions set plan_period = 'lifetime' where guild_id = $1", [G1], /check constraint/);
    await rejects("update public.zb_guild_subscriptions set provider = 'paypal' where guild_id = $1", [G1], /check constraint/);
    await rejects("update public.zb_guild_subscriptions set pending_subscription_id = 'I-PAYPAL0001' where guild_id = $1", [G1], /check constraint/);
    await rejects("update public.zb_guild_subscriptions set status = 'paid' where guild_id = $1", [G1], /check constraint/);
});

const SHA = 'a'.repeat(64);

test('custom identity: browsers can never read or write identity rows or blocks', async () => {
    await asService();
    await db.query(`insert into public.zb_guild_identity (guild_id, nick, avatar_path, avatar_sha256) values ($1, 'Zed', $2, $3)
        on conflict (guild_id) do nothing`, [G1, `${G1}/${SHA}.png`, SHA]);
    for (const user of [A, null]) {
        await as(user);
        await rejects('select * from public.zb_guild_identity', [], /permission denied/);
        await rejects("update public.zb_guild_identity set nick = 'hacked' where guild_id = $1", [G1], /permission denied/);
        await rejects("insert into public.zb_guild_identity (guild_id, nick) values ($1, 'x')", [G2], /permission denied/);
        await rejects('select * from public.zb_identity_blocks', [], /permission denied/);
        await rejects("insert into public.zb_identity_blocks (kind, target_id, context_guild_id) values ('guild', $1, $1)", [G1], /permission denied/);
    }
});

test('custom identity: the database rejects malformed identity rows even from the service role', async () => {
    await asService();
    await rejects("update public.zb_guild_identity set nick = $1 where guild_id = $2", ['x'.repeat(33), G1], /check constraint/);
    await rejects("update public.zb_guild_identity set nick = '' where guild_id = $1", [G1], /check constraint/);
    await rejects("update public.zb_guild_identity set bio = $1 where guild_id = $2", ['x'.repeat(191), G1], /check constraint/);
    await rejects("update public.zb_guild_identity set avatar_path = '../etc/passwd' where guild_id = $1", [G1], /check constraint/);
    await rejects("update public.zb_guild_identity set pending_avatar_path = $1, pending_avatar_sha256 = null where guild_id = $2", [`${G1}/${SHA}.png`, G1], /check constraint/);
    await rejects("update public.zb_guild_identity set pending_avatar_path = null, pending_avatar_sha256 = $1 where guild_id = $2", [SHA, G1], /check constraint/);
    // A picture path must be in this server's own folder.
    await rejects("update public.zb_guild_identity set avatar_path = $1 where guild_id = $2", [`${G2}/${SHA}.png`, G1], /check constraint/);
    await rejects("insert into public.zb_identity_blocks (kind, target_id, context_guild_id) values ('channel', $1, $1)", [G1], /check constraint/);
    await db.query("insert into public.zb_identity_blocks (kind, target_id, context_guild_id) values ('user', '100000000000000009', $1)", [G1]);
    await rejects("insert into public.zb_identity_blocks (kind, target_id, context_guild_id) values ('user', '100000000000000009', $1)", [G1], /duplicate key/);
});

test('custom identity: audit accepts the identity actions, still rejects unknown ones; the bucket is private PNG-only', async () => {
    await asService();
    for (const action of ['APPLY', 'REVERT', 'REVIEW', 'BLOCK', 'RESET', 'INSERT']) {
        await db.query("insert into public.zb_config_audit_log (guild_id, action, table_name) values ($1, $2, 'zb_guild_identity')", [G1, action]);
    }
    await rejects("insert into public.zb_config_audit_log (guild_id, action, table_name) values ($1, 'HACK', 'zb_guild_identity')", [G1], /check constraint/);
    await db.exec('reset role'); // the stub storage schema is owned by the test superuser
    const bucket = await db.query("select public, file_size_limit, allowed_mime_types from storage.buckets where id = 'zb-identity'");
    assert.deepEqual(bucket.rows, [{ public: false, file_size_limit: 1048576, allowed_mime_types: ['image/png'] }]);
    // Removing the server's guild row removes its identity too.
    await db.query("insert into public.zb_guilds (guild_id, name) values ('333333333333333333', 'Gone')");
    await db.query("insert into public.zb_guild_identity (guild_id, nick) values ('333333333333333333', 'Bye')");
    await db.query("delete from public.zb_guilds where guild_id = '333333333333333333'");
    assert.equal((await db.query("select 1 from public.zb_guild_identity where guild_id = '333333333333333333'")).rows.length, 0);
});
