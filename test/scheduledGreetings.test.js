const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createGreetingScheduler } = require('../src/greetings/scheduler');
const { nextOccurrence, validateGreeting, renderGreeting, describeSchedule } = require('../dashboard/lib/shared/greetings');
const { computeChannelPermissions } = require('../dashboard/lib/shared/permissions');

// Scheduled greetings. The database and Discord are faked (an in-memory table
// that applies the same conditional-update rules PostgREST does); time zones
// and the scheduler logic are real.

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\r\n/g, '\n');
const G = '900000000000000001';
const CH = '600000000000000001';
const at = (s) => Date.parse(s);

function fakeTable(rows) {
    const table = rows.map((r) => ({ version: 1, recent_runs: [], ...r }));
    const calls = [];
    const request = async (p, { method = 'GET', body } = {}) => {
        calls.push({ method, path: p, body });
        const [name, query = ''] = p.split('?');
        assert.equal(name, 'zb_greeting_schedules');
        const filters = [...new URLSearchParams(query)].filter(([k]) => !['select', 'order', 'limit'].includes(k));
        const match = (row) => filters.every(([key, raw]) => {
            const [op, ...rest] = raw.split('.');
            const value = rest.join('.');
            if (op === 'eq') return String(row[key]) === value;
            if (op === 'lte') return row[key] !== null && Date.parse(row[key]) <= Date.parse(value);
            throw new Error(`unsupported filter ${raw}`);
        });
        const hits = table.filter(match);
        if (method === 'GET') return hits.sort((a, b) => Date.parse(a.next_run_at) - Date.parse(b.next_run_at)).map((r) => ({ ...r }));
        if (method === 'PATCH') {
            for (const row of hits) Object.assign(row, body);
            return hits.map((r) => ({ ...r }));
        }
        throw new Error(`unsupported ${method}`);
    };
    return { table, calls, guildStore: { enabled: true, request } };
}

function fakeDiscord({ canSend = true, channelExists = true, sendError = null } = {}) {
    const sent = [];
    let failures = 0;
    const channel = {
        id: CH,
        isTextBased: () => true,
        permissionsFor: () => ({ has: () => canSend }),
        send: async (payload) => {
            if (typeof sendError === 'function') {
                const error = sendError(failures += 1);
                if (error) throw error;
            } else if (sendError) {
                throw sendError;
            }
            sent.push(payload);
        }
    };
    const guild = {
        id: G,
        name: 'Study Hub',
        members: { me: { id: 'bot' } },
        channels: { cache: new Map(channelExists ? [[CH, channel]] : []), fetch: async () => null }
    };
    return { client: { isReady: () => true, guilds: { cache: new Map([[G, guild]]) } }, sent, guild };
}

const daily = (extra = {}) => ({
    id: '00000000-0000-4000-8000-000000000001',
    guild_id: G,
    channel_id: CH,
    message: 'Good morning {server}! It is {time}.',
    schedule_type: 'daily',
    start_local: '2026-10-01T09:00',
    time_zone: 'Asia/Kolkata',
    weekdays: [],
    interval_minutes: null,
    end_date: null,
    enabled: true,
    next_run_at: '2026-10-30T03:30:00.000Z', // 09:00 IST
    ...extra
});

function scheduler(store, discord, clock, extra = {}) {
    return createGreetingScheduler({ client: discord.client, guildStore: store.guildStore, now: () => clock.t, sleep: async () => {}, logger: { log() {}, error() {} }, ...extra });
}

// 1. Create and enable a daily greeting.
test('1. an admin can create and enable a daily greeting: validated, next time computed server-side', () => {
    const result = validateGreeting({ channel_id: CH, message: '  Hello {server}  ', schedule_type: 'daily', start_local: '2026-10-01T09:00', time_zone: 'Asia/Kolkata', enabled: true }, { channelIds: new Set([CH]), now: at('2026-10-29T05:00:00Z') });
    assert.equal(result.ok, true);
    assert.equal(result.value.message, 'Hello {server}');
    assert.equal(result.value.next_run_at, '2026-10-30T03:30:00.000Z', 'tomorrow 09:00 IST');
    // The browser can never set next_run_at itself.
    const forged = validateGreeting({ channel_id: CH, message: 'x', schedule_type: 'daily', start_local: '2026-10-01T09:00', time_zone: 'UTC', enabled: true, next_run_at: '2020-01-01T00:00:00Z' }, { channelIds: new Set([CH]), now: at('2026-10-29T05:00:00Z') });
    assert.equal(forged.value.next_run_at, '2026-10-29T09:00:00.000Z');
    const route = read('dashboard/app/api/guilds/[guildId]/greetings/route.js');
    assert.match(route, /export const POST[\s\S]*await requireGuildAdmin\(guildId\)[\s\S]*validateGreeting[\s\S]*assertCanSend[\s\S]*\.insert\(/);
});

// 2 / 3. Sent at the configured time, by the bot alone.
test('2/3. the greeting is sent at its time, once a day, with only the bot running', async () => {
    const store = fakeTable([daily()]);
    const discord = fakeDiscord();
    const clock = { t: at('2026-10-30T03:29:00Z') };
    const s = scheduler(store, discord, clock);
    assert.deepEqual(await s.tick(), [], 'not yet due');
    for (let day = 0; day < 3; day += 1) {
        clock.t = at('2026-10-30T03:30:20Z') + day * 86_400_000;
        assert.deepEqual(await s.tick(), ['sent']);
        assert.deepEqual(await s.tick(), [], 'the next tick does not resend');
    }
    assert.equal(discord.sent.length, 3);
    assert.equal(discord.sent[0].content, 'Good morning Study Hub! It is 09:00.');
    assert.deepEqual(discord.sent[0].allowedMentions, { parse: [] }, 'greetings never ping');
    const row = store.table[0];
    assert.equal(row.next_run_at, '2026-11-02T03:30:00.000Z');
    assert.equal(row.last_status, 'sent');
    assert.equal(row.recent_runs.length, 3);
});

// 4. Survives a restart without a duplicate.
test('4. after a restart the schedule resumes from storage and never resends', async () => {
    const store = fakeTable([daily()]);
    const discord = fakeDiscord();
    const clock = { t: at('2026-10-30T03:30:10Z') };
    assert.deepEqual(await scheduler(store, discord, clock).tick(), ['sent']);
    // "Restart": a brand-new scheduler with only the stored rows.
    clock.t += 20_000;
    assert.deepEqual(await scheduler(store, discord, clock).tick(), []);
    clock.t = at('2026-10-31T03:30:05Z');
    assert.deepEqual(await scheduler(store, discord, clock).tick(), ['sent']);
    assert.equal(discord.sent.length, 2);
});

// 5 / 6. Pause and resume.
test('5/6. pausing stops greetings; resuming continues from the next future time (no backlog)', async () => {
    const store = fakeTable([daily({ enabled: false, next_run_at: null })]);
    const discord = fakeDiscord();
    const clock = { t: at('2026-11-05T03:30:10Z') };
    assert.deepEqual(await scheduler(store, discord, clock).tick(), []);
    assert.equal(discord.sent.length, 0);
    // Resume (as the PATCH route does): validated from the stored row, from now.
    const resumed = validateGreeting({ ...store.table[0], enabled: true }, { channelIds: new Set([CH]), now: clock.t });
    assert.equal(resumed.value.next_run_at, '2026-11-06T03:30:00.000Z', 'today\'s 09:00 already passed: tomorrow, not a catch-up send');
    const patch = read('dashboard/app/api/guilds/[guildId]/greetings/[scheduleId]/route.js');
    assert.match(patch, /if \(input\.enabled === false && !body\.schedule\) \{[\s\S]*next = \{ enabled: false, next_run_at: null \}/, 'pause clears the next time');
});

// 7. One-time greetings run once.
test('7. a one-time greeting is sent once and then switches itself off', async () => {
    const store = fakeTable([daily({ schedule_type: 'once', start_local: '2026-10-30T09:00', next_run_at: '2026-10-30T03:30:00.000Z' })]);
    const discord = fakeDiscord();
    const clock = { t: at('2026-10-30T03:30:10Z') };
    const s = scheduler(store, discord, clock);
    assert.deepEqual(await s.tick(), ['sent']);
    assert.equal(store.table[0].enabled, false);
    assert.equal(store.table[0].next_run_at, null);
    for (const d of [1, 2, 7]) {
        clock.t += d * 86_400_000;
        assert.deepEqual(await s.tick(), []);
    }
    assert.equal(discord.sent.length, 1);
    assert.match(validateGreeting({ channel_id: CH, message: 'x', schedule_type: 'once', start_local: '2026-10-01T09:00', time_zone: 'UTC', enabled: true }, { channelIds: new Set([CH]), now: at('2026-10-29T00:00:00Z') }).errors.start_local, /already passed/);
});

// 8. Weekly, time zones and daylight saving.
test('8. weekly schedules respect weekdays and time zones, across DST changes', () => {
    const london = { schedule_type: 'weekly', weekdays: [1, 3], start_local: '2026-10-01T18:00', time_zone: 'Europe/London' };
    assert.equal(new Date(nextOccurrence(london, at('2026-10-29T12:00:00Z'))).toISOString(), '2026-11-02T18:00:00.000Z', 'Thu → next Mon, GMT');
    assert.equal(new Date(nextOccurrence(london, at('2026-11-02T18:00:00Z'))).toISOString(), '2026-11-04T18:00:00.000Z', 'Mon → Wed');
    assert.equal(new Date(nextOccurrence(london, at('2026-10-12T00:00:00Z'))).toISOString(), '2026-10-12T17:00:00.000Z', 'BST: 18:00 local is 17:00 UTC');
    const ny = { schedule_type: 'daily', start_local: '2026-10-01T09:00', time_zone: 'America/New_York' };
    assert.equal(new Date(nextOccurrence(ny, at('2026-10-31T12:00:00Z'))).toISOString(), '2026-10-31T13:00:00.000Z', 'EDT');
    assert.equal(new Date(nextOccurrence(ny, at('2026-10-31T14:00:00Z'))).toISOString(), '2026-11-01T14:00:00.000Z', 'still 09:00 local after the clocks change');
    const ist = { schedule_type: 'weekly', weekdays: [5], start_local: '2026-10-01T20:30', time_zone: 'Asia/Kolkata' };
    assert.equal(new Date(nextOccurrence(ist, at('2026-10-29T00:00:00Z'))).toISOString(), '2026-10-30T15:00:00.000Z', 'Friday 20:30 IST');
    // Interval and end date.
    assert.equal(new Date(nextOccurrence({ schedule_type: 'interval', interval_minutes: 180, start_local: '2026-10-29T10:00', time_zone: 'UTC' }, at('2026-10-29T14:00:00Z'))).toISOString(), '2026-10-29T16:00:00.000Z');
    assert.equal(nextOccurrence({ schedule_type: 'daily', start_local: '2026-10-01T09:00', end_date: '2026-10-29', time_zone: 'UTC' }, at('2026-10-29T10:00:00Z')), null);
    assert.equal(describeSchedule(london), 'Every Mon, Wed at 18:00 (Europe/London)');
});

test('validation keeps schedules sane and spam-free', () => {
    const base = { channel_id: CH, message: 'Hi', start_local: '2026-11-01T09:00', time_zone: 'UTC', enabled: true };
    const opts = { channelIds: new Set([CH]), now: at('2026-10-29T00:00:00Z') };
    assert.match(validateGreeting({ ...base, schedule_type: 'interval', interval_minutes: 30 }, opts).errors.interval_minutes, /1 to 168 hours/);
    assert.ok(validateGreeting({ ...base, schedule_type: 'weekly', weekdays: [] }, opts).errors.weekdays);
    assert.ok(validateGreeting({ ...base, schedule_type: 'daily', channel_id: '600000000000000099' }, opts).errors.channel_id, 'only this server\'s channels');
    assert.ok(validateGreeting({ ...base, schedule_type: 'daily', time_zone: 'Mars/Olympus' }, opts).errors.time_zone);
    assert.ok(validateGreeting({ ...base, schedule_type: 'daily', message: 'x'.repeat(1501) }, opts).errors.message);
    assert.ok(validateGreeting({ ...base, schedule_type: 'daily', end_date: '2026-10-01' }, opts).errors.end_date);
    assert.equal(renderGreeting('{SERVER} · {date}', { serverName: 'A', timeZone: 'UTC', now: at('2026-10-29T00:00:00Z') }), 'A · Thursday, 29 October 2026');
});

// Missed occurrence policy.
test('a greeting missed while the bot was offline is skipped (not sent late), and the schedule continues', async () => {
    const store = fakeTable([daily()]);
    const discord = fakeDiscord();
    const late = { t: at('2026-10-30T04:00:00Z') }; // 30 min late
    assert.deepEqual(await scheduler(store, discord, late).tick(), ['missed']);
    assert.equal(discord.sent.length, 0);
    assert.equal(store.table[0].next_run_at, '2026-10-31T03:30:00.000Z');
    // Up to 15 minutes late is still sent.
    const store2 = fakeTable([daily()]);
    const discord2 = fakeDiscord();
    assert.deepEqual(await scheduler(store2, discord2, { t: at('2026-10-30T03:44:00Z') }).tick(), ['sent']);
    // Days offline: one skip, no backlog of sends.
    const store3 = fakeTable([daily()]);
    const discord3 = fakeDiscord();
    assert.deepEqual(await scheduler(store3, discord3, { t: at('2026-11-04T12:00:00Z') }).tick(), ['missed']);
    assert.equal(store3.table[0].next_run_at, '2026-11-05T03:30:00.000Z');
});

// 9. Authorization and isolation.
test('9. only verified admins of THIS server can manage its greetings; browsers get no table access', async () => {
    const routes = ['greetings/route.js', 'greetings/[scheduleId]/route.js', 'greetings/[scheduleId]/send-test/route.js']
        .map((r) => read(`dashboard/app/api/guilds/[guildId]/${r}`));
    for (const route of routes) {
        for (const verb of route.match(/export const (GET|POST|PATCH|DELETE)/g)) {
            const body = route.slice(route.indexOf(verb));
            assert.match(body.slice(0, 400), /await requireGuildAdmin\(guildId\)/, `${verb} checks admin first`);
        }
        assert.doesNotMatch(route, /\.eq\('id', [^)]+\)(?![\s\S]{0,80}guild_id)/, 'every id lookup is pinned to the guild');
    }
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
    const migrations = fs.readdirSync(path.join(ROOT, 'supabase', 'migrations')).filter((n) => n.endsWith('.sql')).sort()
        .map((n) => fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', n), 'utf8')).join('\n');
    await db.exec(migrations);
    await db.exec(migrations);
    await db.exec('set role service_role');
    await db.query("insert into public.zb_guilds (guild_id, name) values ($1, 'x')", [G]);
    await db.query("insert into public.zb_greeting_schedules (guild_id, channel_id, message, schedule_type, start_local, time_zone) values ($1, $2, 'hi', 'daily', '2026-10-01T09:00', 'UTC')", [G, CH]);
    await assert.rejects(() => db.query("insert into public.zb_greeting_schedules (guild_id, channel_id, message, schedule_type, start_local, time_zone, interval_minutes) values ($1, $2, 'spam', 'interval', '2026-10-01T09:00', 'UTC', 5)", [G, CH]), /check constraint/, 'no faster than hourly, even in the database');
    await assert.rejects(() => db.query("insert into public.zb_greeting_schedules (guild_id, channel_id, message, schedule_type, start_local, time_zone) values ($1, $2, 'x', 'weekly', '2026-10-01T09:00', 'UTC')", [G, CH]), /check constraint/);
    for (const role of ['authenticated', 'anon']) {
        await db.exec(`reset role; set role ${role}`);
        await assert.rejects(() => db.query('select * from public.zb_greeting_schedules'), /permission denied/);
    }
    await db.close();
});

// 10. Missing channels and permissions.
test('10. a deleted channel pauses the schedule; missing permission and Discord errors are recorded, not crashed on', async () => {
    const gone = fakeTable([daily()]);
    assert.deepEqual(await scheduler(gone, fakeDiscord({ channelExists: false }), { t: at('2026-10-30T03:30:10Z') }).tick(), ['channel_missing']);
    assert.equal(gone.table[0].enabled, false, 'paused: the channel will not come back');
    const blocked = fakeTable([daily()]);
    assert.deepEqual(await scheduler(blocked, fakeDiscord({ canSend: false }), { t: at('2026-10-30T03:30:10Z') }).tick(), ['no_permission']);
    assert.equal(blocked.table[0].enabled, true, 'kept: an admin can fix the permission');
    assert.equal(blocked.table[0].next_run_at, '2026-10-31T03:30:00.000Z');
    const refused = fakeTable([daily()]);
    assert.deepEqual(await scheduler(refused, fakeDiscord({ sendError: Object.assign(new Error('Missing Permissions'), { code: 50013, status: 403 }) }), { t: at('2026-10-30T03:30:10Z') }).tick(), ['no_permission']);
    // A Discord outage: retried a bounded number of times, then recorded.
    const flaky = fakeTable([daily()]);
    const flakyDiscord = fakeDiscord({ sendError: (n) => (n < 3 ? Object.assign(new Error('Server Error'), { status: 503 }) : null) });
    assert.deepEqual(await scheduler(flaky, flakyDiscord, { t: at('2026-10-30T03:30:10Z') }).tick(), ['sent']);
    assert.equal(flakyDiscord.sent.length, 1);
    const down = fakeTable([daily()]);
    assert.deepEqual(await scheduler(down, fakeDiscord({ sendError: Object.assign(new Error('Server Error'), { status: 503 }) }), { t: at('2026-10-30T03:30:10Z') }).tick(), ['failed']);
    assert.equal(down.table[0].last_error, '503');
    // Channel permission maths used by the dashboard before saving.
    const P = { VIEW: 1n << 10n, SEND: 1n << 11n };
    const guild = { id: G, owner_id: '1', roles: [{ id: G, permissions: String(P.VIEW | P.SEND) }, { id: '700000000000000001', permissions: '0' }] };
    const member = { user: { id: '100000000000000009' }, roles: ['700000000000000001'] };
    const can = (overwrites) => (computeChannelPermissions(guild, member, { permission_overwrites: overwrites }) & (P.VIEW | P.SEND)) === (P.VIEW | P.SEND);
    assert.equal(can([]), true);
    assert.equal(can([{ id: G, type: 0, allow: '0', deny: String(P.SEND) }]), false, '@everyone denied');
    assert.equal(can([{ id: G, type: 0, allow: '0', deny: String(P.SEND) }, { id: '700000000000000001', type: 0, allow: String(P.SEND), deny: '0' }]), true, 'role allow beats @everyone deny');
    assert.equal(can([{ id: '100000000000000009', type: 1, allow: '0', deny: String(P.VIEW) }]), false, 'member overwrite wins');
});

// 11. No duplicates with several workers or overlapping ticks.
test('11. two workers and overlapping ticks never send the same greeting twice', async () => {
    const store = fakeTable([daily()]);
    const discord = fakeDiscord();
    const clock = { t: at('2026-10-30T03:30:10Z') };
    const a = scheduler(store, discord, clock);
    const b = scheduler(store, discord, clock);
    const results = await Promise.all([a.tick(), b.tick(), a.tick(), b.tick()]);
    assert.equal(discord.sent.length, 1);
    assert.equal(results.flat().filter((r) => r === 'sent').length, 1);
    // A claim made from a stale read (e.g. the dashboard edited it meanwhile) loses.
    const edited = fakeTable([daily()]);
    const staleRow = { ...edited.table[0] };
    edited.table[0].version = 2;
    assert.equal(await scheduler(edited, discord, clock).claim(staleRow, clock.t), null);
});

// 12. Deleting stops future greetings.
test('12. a deleted schedule is never sent again', async () => {
    const store = fakeTable([daily()]);
    const discord = fakeDiscord();
    store.table.splice(0, 1); // DELETE (pinned to id + guild in the route)
    assert.deepEqual(await scheduler(store, discord, { t: at('2026-10-30T03:30:10Z') }).tick(), []);
    assert.equal(discord.sent.length, 0);
    assert.match(read('dashboard/app/api/guilds/[guildId]/greetings/[scheduleId]/route.js'), /\.delete\(\)\.eq\('id', scheduleId\)\.eq\('guild_id', String\(guild\.id\)\)/);
});

test('the bot starts the scheduler and the Roles tab shows the card', () => {
    const index = read('src/index.js');
    assert.match(index, /const greetingScheduler = createGreetingScheduler\(\{ client, guildStore \}\)/);
    assert.match(index, /greetingScheduler\.start\(\);/);
    const editor = read('dashboard/components/GuildEditor.js');
    assert.match(editor, /tab === 'roles' \? <div style=\{\{ marginTop: 16 \}\}><GreetingsCard guildId=\{initial\.guild\.id\} toast=\{toast\} \/><\/div> : null/);
    const card = read('dashboard/components/GreetingsCard.js');
    for (const label of ['Scheduled Greeting', 'Enable Greeting Alarm', 'Save Schedule', 'Test Greeting', 'Configure', 'Pause', 'Resume', 'Delete', 'Active', 'Paused']) assert.ok(card.includes(label), label);
    assert.match(card, /\/send-test`/);
});
