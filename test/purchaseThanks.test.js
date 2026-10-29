const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { buildThanksMessage } = require('../dashboard/lib/shared/purchaseThanks');

// "Thank you for purchasing" DM. Discord is not called here: the message
// text is tested directly, the once-only send in its source and in Postgres.

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\r\n/g, '\n');
const PROFILE = 'https://discord.com/users/1296202178263912448';
const PORTFOLIO = 'https://aibhaveshportfolio.vercel.app/#contact';

test('the DM thanks the buyer for their verified plan and links the creator', () => {
    const monthly = buildThanksMessage({ purchase: { plan_period: 'monthly', amount_paise: 39900, currency: 'INR' }, serverName: 'Study Hub', contactUrl: PROFILE, portfolioUrl: PORTFOLIO });
    assert.match(monthly, /Thank you for purchasing ZiGBoT Premium!/);
    assert.match(monthly, /Your \*\*₹399 Premium\*\* for \*\*Study Hub\*\* is active now/);
    assert.match(monthly, /contact ZiG, ZiGBoT's creator/);
    assert.ok(monthly.includes(`<${PROFILE}>`), 'Discord profile link, without a big preview card');
    assert.ok(monthly.includes(`<${PORTFOLIO}>`));
    assert.ok(monthly.length < 2000);
    const yearly = buildThanksMessage({ purchase: { plan_period: 'yearly', amount_paise: 399900, currency: 'INR' }, serverName: 'X', contactUrl: PROFILE });
    assert.match(yearly, /₹3,999 Premium/);
});

test('the DM never pings and degrades gracefully', () => {
    const sneaky = buildThanksMessage({ purchase: { plan_period: 'monthly' }, serverName: '@everyone **Free Nitro** `x`', contactUrl: null, portfolioUrl: PORTFOLIO });
    assert.doesNotMatch(sneaky, /@everyone/);
    assert.match(sneaky, /for \*\*everyone Free Nitro x\*\*/);
    assert.match(sneaky, /Monthly Premium/, 'unknown amount: plan name, never a guessed price');
    assert.doesNotMatch(sneaky, /Message ZiG on Discord/, 'no profile link without BOT_CREATOR_ID');
    const bare = buildThanksMessage({ purchase: { plan_period: 'yearly' } });
    assert.match(bare, /Premium tab/, 'still tells them where to get help');
});

test('the DM goes out once per new verified purchase, never on renewals, never twice', () => {
    const code = read('dashboard/lib/feedback.js');
    assert.match(code, /purchase = await purchases\.recordVerifiedPurchase\([\s\S]*await sendPurchaseThanks\(purchase\);/, 'after the verified purchase is recorded');
    assert.match(code, /if \(!\(Date\.now\(\) - Date\.parse\(purchase\.verified_at \|\| ''\) < THANKS_WINDOW_MS\)\) return 'skipped';/, 'old purchases (renewals) are never thanked again');
    const claim = code.indexOf(".is('thanks_claimed_at', null)");
    const send = code.indexOf('await sendDirectMessage(recipient');
    assert.ok(claim > 0 && send > claim, 'claimed in the database before sending');
    assert.match(code, /if \(error \|\| !claimed\?\.length\) return 'skipped';/, 'no claim (or no migration): no DM');
    assert.match(code, /const recipient = purchase\.discord_user_id \|\| guild\?\.owner_discord_id \|\| null;/, 'the buyer, else the server owner');
    assert.match(code, /dmError\?\.code === 50007 \? 'dm_closed' : 'failed'/);
    // Activation never waits on or fails because of the DM.
    assert.match(code, /export async function sendPurchaseThanks[\s\S]*catch \(error\) \{\n\s+console\.error\('\[premium\] thank-you DM skipped:'[\s\S]*return 'skipped';/);
});

test('the database keeps one claim per purchase', async () => {
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
    const dir = path.join(ROOT, 'supabase', 'migrations');
    const sql = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
    await db.exec(sql);
    await db.exec(sql);
    const { rows: [p] } = await db.query("insert into public.zb_premium_purchases (subscription_id, guild_id, plan_period) values ('sub_KKKKKKKK01', '900000000000000001', 'monthly') returning id");
    const claim = () => db.query('update public.zb_premium_purchases set thanks_claimed_at = now() where id = $1 and thanks_claimed_at is null returning id', [p.id]);
    assert.equal((await claim()).rows.length, 1);
    assert.equal((await claim()).rows.length, 0, 'a second sender gets nothing to send');
    await assert.rejects(db.query("update public.zb_premium_purchases set thanks_status = 'spammed' where id = $1", [p.id]), /check constraint/);
    await db.close();
});
