/**
 * Razorpay diagnostics for ZiGBoT Premium checkout.
 *
 *   node dashboard/scripts/razorpay-check.mjs
 *
 * Reads RAZORPAY_* from dashboard/.env.local (never hard-coded), prints the
 * key MODE and the first 12 characters of the key ID only — never the
 * secret — then checks the plans and tries one subscription exactly like the
 * dashboard does. A subscription it creates is cancelled immediately (an
 * unpaid "created" subscription never charges anyone).
 *
 * Note: the live website uses the env vars set in Vercel, not this file.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const API = 'https://api.razorpay.com/v1';
const ENV_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env.local');

function loadEnv(file) {
    if (!fs.existsSync(file)) {
        console.error(`No env file at ${file}`);
        process.exit(1);
    }
    if (typeof process.loadEnvFile === 'function') {
        process.loadEnvFile(file);
        return;
    }
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
        const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (!match || process.env[match[1]] !== undefined) continue;
        process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
    }
}

loadEnv(ENV_FILE);

const keyId = process.env.RAZORPAY_KEY_ID || '';
const keySecret = process.env.RAZORPAY_KEY_SECRET || '';
const plans = { monthly: process.env.RAZORPAY_PLAN_MONTHLY || '', yearly: process.env.RAZORPAY_PLAN_YEARLY || '' };

const mode = keyId.startsWith('rzp_live_') ? 'LIVE' : keyId.startsWith('rzp_test_') ? 'TEST' : 'UNKNOWN';
console.log(`Env file:      ${ENV_FILE}`);
console.log(`Key mode:      ${mode} (key id starts ${keyId.slice(0, 12) || '(missing)'}…)`);
console.log(`Key secret:    ${keySecret ? 'set (hidden)' : 'MISSING'}`);
console.log(`Monthly plan:  ${plans.monthly ? `set (${plans.monthly})` : 'MISSING'}`);
console.log(`Yearly plan:   ${plans.yearly ? `set (${plans.yearly})` : 'MISSING'}`);
if (!keyId || !keySecret) process.exit(1);

const auth = `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`;

async function rzp(method, urlPath, body) {
    const response = await fetch(`${API}${urlPath}`, {
        method,
        headers: { Authorization: auth, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body)
    });
    const data = await response.json().catch(() => ({}));
    return { status: response.status, ok: response.ok, data };
}

const showError = (label, result) => console.log(`  ${label}: HTTP ${result.status} ${JSON.stringify(result.data)}`);

console.log('\n(a) Configured plans');
for (const [period, id] of Object.entries(plans)) {
    if (!id) {
        console.log(`  ${period}: not set`);
        continue;
    }
    const result = await rzp('GET', `/plans/${encodeURIComponent(id)}`);
    if (result.ok) {
        const p = result.data;
        console.log(`  ${period}: HTTP ${result.status} ${p.id} period=${p.period} interval=${p.interval} amount=${p.item?.amount} ${p.item?.currency}`);
    } else showError(period, result);
}

console.log(`\n(b) Plans that exist in ${mode} mode`);
const list = await rzp('GET', '/plans?count=10');
if (list.ok) {
    if (!list.data.items?.length) console.log('  (none)');
    for (const p of list.data.items || []) console.log(`  ${p.id}  ${p.period} x${p.interval}  ${p.item?.amount / 100} ${p.item?.currency}  "${p.item?.name}"`);
} else showError('list', list);

async function trySubscription(totalCount) {
    const result = await rzp('POST', '/subscriptions', {
        plan_id: plans.monthly,
        total_count: totalCount,
        customer_notify: 1,
        notes: { guild_id: 'diagnostic' }
    });
    if (result.ok) {
        console.log(`  total_count=${totalCount}: HTTP ${result.status} OK id=${result.data.id} status=${result.data.status}`);
        const cancel = await rzp('POST', `/subscriptions/${result.data.id}/cancel`, {});
        console.log(`  cleanup cancel: HTTP ${cancel.status}${cancel.ok ? ` status=${cancel.data.status}` : ` ${JSON.stringify(cancel.data)}`}`);
    } else showError(`total_count=${totalCount}`, result);
    return result;
}

console.log('\n(c) Create a subscription like the dashboard (monthly plan, total_count 60)');
if (!plans.monthly) console.log('  skipped: RAZORPAY_PLAN_MONTHLY is not set');
else {
    const first = await trySubscription(60);
    const description = String(first.data?.error?.description || '');
    if (!first.ok && /total_count|end date|end_at|expire/i.test(description)) {
        console.log('\n(d) Retry with total_count 12');
        const retry = await trySubscription(12);
        console.log(`  => total_count 12 ${retry.ok ? 'WORKS' : 'also fails'}`);
    }
}
