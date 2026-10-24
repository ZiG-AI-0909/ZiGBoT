const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Custom bot identity: the dashboard routes are Next.js server modules (not
// loadable here), so these checks pin the wiring that keeps the feature
// gated, authorised, and honest in the policy pages.
const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const { loadSettings } = require('../src/config/settings');

const KEYS = ['DISCORD_TOKEN', 'GROQ_API_KEY', 'NVIDIA_API_KEY', 'CUSTOM_IDENTITY_ENABLED', 'CUSTOM_IDENTITY_GUILDS'];

function withEnv(values, fn) {
    const saved = Object.fromEntries(KEYS.map((name) => [name, process.env[name]]));
    try {
        for (const name of KEYS) {
            if (values[name] === undefined) delete process.env[name];
            else process.env[name] = values[name];
        }
        return fn();
    } finally {
        for (const [name, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
    }
}

test('CUSTOM_IDENTITY_ENABLED is off unless exactly "true", in the bot and the dashboard', () => {
    for (const [value, expected] of [[undefined, false], ['false', false], ['TRUE', false], ['1', false], ['true', true]]) {
        const settings = withEnv({ DISCORD_TOKEN: 'token', GROQ_API_KEY: 'groq-key', CUSTOM_IDENTITY_ENABLED: value }, () => loadSettings());
        assert.equal(settings.customIdentityEnabled, expected, String(value));
    }
    assert.match(read('dashboard/lib/env.js'), /customIdentityEnabled\(\) \{ return process\.env\.CUSTOM_IDENTITY_ENABLED === 'true'; \}/);
});

test('CUSTOM_IDENTITY_GUILDS is read the same way by the bot and the dashboard', () => {
    const unset = withEnv({ DISCORD_TOKEN: 'token', GROQ_API_KEY: 'groq-key' }, () => loadSettings());
    assert.deepEqual(unset.customIdentityGuilds, []);
    const listed = withEnv({ DISCORD_TOKEN: 'token', GROQ_API_KEY: 'groq-key', CUSTOM_IDENTITY_GUILDS: '123456789012345678, nope' }, () => loadSettings());
    assert.deepEqual(listed.customIdentityGuilds, ['123456789012345678']);
    assert.match(read('dashboard/lib/env.js'), /customIdentityGuilds\(\) \{ return identityRules\.parseIdentityGuilds\(process\.env\.CUSTOM_IDENTITY_GUILDS\); \}/);
    assert.match(read('dashboard/lib/identity.js'), /return env\.customIdentityEnabled && identityAllowedInGuild\(guildId, env\.customIdentityGuilds\);/);
    const index = read('src/index.js');
    assert.match(index, /guilds: settings\.customIdentityGuilds/);
});

test('the invite asks for Change Nickname only while the feature is on, and never for Administrator', () => {
    const discord = read('dashboard/lib/discord.js');
    const bits = discord.match(/INVITE_PERMISSIONS = \[([^\]]+)\]/)[1].split(',').map((b) => b.trim().replace('n', ''));
    assert.ok(!bits.includes('3') && !bits.includes('26'), 'base invite: no Administrator, no Change Nickname');
    assert.match(discord, /CHANGE_NICKNAME = 1n << 26n/);
    assert.match(discord, /env\.customIdentityEnabled \? \(BigInt\(INVITE_PERMISSIONS\) \| CHANGE_NICKNAME\)/);
});

test('dashboard routes: gated, admin-checked server-side, owner-only review', () => {
    const route = read('dashboard/app/api/guilds/[guildId]/identity/route.js');
    const put = route.slice(route.indexOf('export const PUT'), route.indexOf('export const DELETE'));
    assert.ok(put.includes('identityEnabledFor(guildId)') && put.indexOf('identityEnabledFor(guildId)') < put.indexOf('requireGuildAdmin'), 'flag and server list checked first');
    const get = route.slice(route.indexOf('export const GET'), route.indexOf('export const PUT'));
    assert.match(get, /if \(!identityEnabledFor\(guild\.id\)\) return json\(\{ enabled: false \}\)/);
    for (const call of ['requireGuildAdmin(guildId)', 'validateIdentityName', 'validateIdentityBio', 'decideIdentitySave', 'loadPlan(guild)', 'getBlocks', 'countRecentSaves', 'processAvatar', 'notifyOwnerOfPending', 'writeAudit']) {
        assert.ok(put.includes(call), `PUT uses ${call}`);
    }
    assert.ok(put.indexOf('pushIdentity') < put.indexOf('saveIdentityRow'), 'Discord accepts the name before it is saved');
    const del = route.slice(route.indexOf('export const DELETE'));
    assert.ok(del.includes('requireGuildAdmin') && del.includes('resetIdentity'));
    assert.ok(!del.includes('customIdentityEnabled') && !del.includes('premium'), 'reset is always allowed for admins');

    const owner = read('dashboard/app/api/owner/identity/route.js');
    assert.match(owner, /if \(!isBotOwner\(current\.discordId\)\) throw new HttpError\(404/);
    assert.match(read('dashboard/app/owner/identity/page.js'), /if \(!current \|\| !isBotOwner\(current\.discordId\)\) notFound\(\)/);
    const avatar = read('dashboard/app/api/guilds/[guildId]/identity/avatar/route.js');
    assert.match(avatar, /if \(!isBotOwner\(current\.discordId\)\) await requireGuildAdmin\(guildId\)/);
    assert.match(avatar, /'X-Content-Type-Options': 'nosniff'/);
});

test('Premium lapse reverts from the billing webhook too (best effort; the bot sync is the safety net)', () => {
    const webhook = read('dashboard/app/api/billing/razorpay/webhook/route.js');
    assert.ok(webhook.indexOf('await syncSubscription(subscription)') < webhook.indexOf('await revertLapsedIdentity('));
    assert.match(webhook, /if \(guild && !premium\) await revertIdentity\(guildId, 'premium_lapsed'\)/);
});

test('the audit log never stores picture bytes or paths, only hashes', () => {
    const lib = read('dashboard/lib/identity.js');
    const view = lib.slice(lib.indexOf('export function auditView'), lib.indexOf('export async function writeAudit'));
    assert.ok(!view.includes('avatar_path') && !view.includes('png'), 'auditView has no paths or bytes');
    const sync = read('src/identity/sync.js');
    const botView = sync.slice(sync.indexOf('const auditView'), sync.indexOf('function createIdentitySync'));
    assert.ok(!botView.includes('avatar_path'));
});

test('the editor shows the Identity tab and the perk only while the feature is on', () => {
    const editor = read('dashboard/components/GuildEditor.js');
    assert.match(editor, /TABS\.filter\(\(t\) => t\.id !== 'identity' \|\| meta\.identityEnabled\)/);
    assert.match(editor, /tab === 'identity' && meta\.identityEnabled/);
    const page = read('dashboard/app/dashboard/[guildId]/page.js');
    assert.match(page, /perks: premiumPerks\(\{ customIdentity: identityEnabledFor\(guildId\) \}\), identityEnabled: identityEnabledFor\(guildId\)/);
    assert.match(read('dashboard/components/IdentityTab.js'), /APP tag/);
});

test('Privacy and Terms describe the feature as it works', () => {
    const privacy = read('dashboard/app/privacy/page.js');
    assert.match(privacy, /Custom bot identity \(Premium, when available\)/);
    assert.match(privacy, /metadata \(such as location or camera details\) removed/);
    assert.match(privacy, /checked by the bot owner before they are used/);
    assert.match(privacy, /deleted 30 days later/);
    assert.match(privacy, /<code>\/identity reset<\/code>/);
    const terms = read('dashboard/app/terms/page.js');
    assert.match(terms, /<h3>Custom bot identity<\/h3>/);
    assert.match(terms, /pretend to be Discord, Discord staff, ZiGBoT staff, another well-known bot, or a real person/);
    assert.match(terms, /Discord always shows\s+ZiGBoT&apos;s APP tag/);
});
