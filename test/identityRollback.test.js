/**
 * The custom identity migration and its rollback, run for real in PGlite
 * (Postgres compiled to WASM) with a stub of Supabase's auth/storage schemas:
 * up → down → up must work, and the rollback must refuse to run while audit
 * history still uses the identity actions.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const MIGRATIONS_DIR = path.join(root, 'supabase', 'migrations');
const migrations = fs.readdirSync(MIGRATIONS_DIR).filter((n) => n.endsWith('.sql')).sort();
const UP = fs.readFileSync(path.join(MIGRATIONS_DIR, '20261024000000_zigbot_custom_identity.sql'), 'utf8');
const DOWN = fs.readFileSync(path.join(root, 'supabase', 'rollback', '20261024000000_zigbot_custom_identity.down.sql'), 'utf8');

test('identity migration: up → down → up, and the rollback protects audit history', async () => {
    const { PGlite } = await import('@electric-sql/pglite');
    const db = new PGlite();
    try {
        await db.exec(`
            create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
            create schema auth; create table auth.users (id uuid primary key);
            create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
            create schema storage;
            create table storage.buckets (id text primary key, name text not null, public boolean default false, file_size_limit bigint, allowed_mime_types text[]);
            create table storage.objects (id bigserial primary key, bucket_id text, name text);
        `);
        for (const name of migrations) await db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8'));
        const exists = async (table) => (await db.query('select to_regclass($1) as t', [table])).rows[0].t !== null;
        assert.ok(await exists('public.zb_guild_identity'));

        // Refuses while identity audit history exists; nothing is changed.
        await db.query("insert into public.zb_guilds (guild_id, name) values ('111111111111111111', 'G')");
        await db.query("insert into public.zb_config_audit_log (guild_id, action, table_name) values ('111111111111111111', 'APPLY', 'zb_guild_identity')");
        await assert.rejects(() => db.exec(DOWN), /still has APPLY\/REVERT\/REVIEW\/BLOCK rows/);
        assert.ok(await exists('public.zb_guild_identity'), 'nothing dropped when it refuses');

        await db.query("delete from public.zb_config_audit_log where action = 'APPLY'");
        await db.exec(DOWN);
        assert.equal(await exists('public.zb_guild_identity'), false);
        assert.equal(await exists('public.zb_identity_blocks'), false);
        assert.equal((await db.query("select count(*)::int as n from storage.buckets where id = 'zb-identity'")).rows[0].n, 0);
        await assert.rejects(() => db.query("insert into public.zb_config_audit_log (guild_id, action, table_name) values ('111111111111111111', 'REVIEW', 'x')"), /check constraint/);
        await db.query("insert into public.zb_config_audit_log (guild_id, action, table_name) values ('111111111111111111', 'UPDATE', 'x')");

        await db.exec(UP); // and it can be applied again afterwards
        assert.ok(await exists('public.zb_guild_identity'));
    } finally {
        await db.close();
    }
});
