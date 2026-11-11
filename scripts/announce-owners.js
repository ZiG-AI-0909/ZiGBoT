#!/usr/bin/env node
/**
 * One-time DM to every owner of a server ZiGBoT is in, about AFK and the
 * avatar viewer (cbe363a).
 *
 *   node scripts/announce-owners.js          dry run: who would get what, sends NOTHING
 *   node scripts/announce-owners.js --send   sends the DMs
 *   ... --send --only <ownerId>               just that one owner (a preview to yourself)
 *
 * - REST only (no gateway login), so the running bot is not disturbed.
 * - One DM per owner, listing all of their servers.
 * - logs/announce-afk-av.json remembers who was messaged: running it again
 *   never messages anyone twice.
 * - No pings (allowed_mentions parse: []), waits between DMs and honours
 *   Discord's rate limits; owners with DMs closed are skipped and listed.
 * Token: DISCORD_TOKEN (or DISCORD_BOT_TOKEN) from the environment, .env,
 * or dashboard/.env.local. It is never printed.
 */
const fs = require('node:fs');
const path = require('node:path');

const API = 'https://discord.com/api/v10';
const LOG_FILE = path.join(__dirname, '..', 'logs', 'announce-afk-av.json');
const SNOWFLAKE = /^\d{17,20}$/;
const GAP_MS = 1500;

// Server names are shown as text: no pings, no markdown.
const clean = (name) => String(name || 'a server')
    .replace(/<@[!&]?\d+>/g, '')
    .replace(/@(everyone|here)/gi, '$1')
    .replace(/[\\*_~`|>#[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60) || 'a server';

function listServers(servers) {
    const names = servers.map((s) => `**${clean(s)}**`);
    if (names.length > 5) return `${names.slice(0, 5).join(', ')} and ${names.length - 5} more`;
    if (names.length === 1) return names[0];
    return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

function buildOwnerMessage({ servers }) {
    return [
        `👋 Hi! You own ${listServers(servers)}, where ZiGBoT is installed. Two new features just went live, no setup needed:`,
        '',
        '💤 **AFK**',
        '• Type `afk I have work` (any reason), and ZiGBoT announces that you are away.',
        '• Anyone who mentions you sees your reason and how long you have been gone.',
        '• Your next message welcomes you back with a little AFK report.',
        '',
        '🖼️ **Avatar viewer**',
        '• `av @user`, `pfp @user`, `dp @user` or `show me the avatar of @user`',
        '• Full-size picture with PNG / JPG / WEBP links, plus their server avatar if they have one.',
        '',
        '⚙️ **Optional:** to let ZiGBoT add "[AFK]" to nicknames, give its role **Manage Nicknames** (Server Settings → Roles → ZiGBoT) and keep that role above your members\' roles.',
        '',
        'Settings and help: <https://www.zigbot.in>',
        '-# You are getting this one-time message because you own a server where ZiGBoT is installed.'
    ].join('\n');
}

/** [{ ownerId, servers: [names] }], one per owner, skipping invalid ids and skipIds. */
function groupByOwner(guilds, { skipIds = [] } = {}) {
    const byOwner = new Map();
    for (const guild of guilds) {
        const owner = String(guild.owner_id || '');
        if (!SNOWFLAKE.test(owner) || skipIds.includes(owner)) continue;
        if (!byOwner.has(owner)) byOwner.set(owner, []);
        byOwner.get(owner).push(guild.name);
    }
    return [...byOwner].map(([ownerId, servers]) => ({ ownerId, servers }));
}

// ----------------------------------------------------------------- Discord
function loadToken() {
    if (!process.env.DISCORD_TOKEN && !process.env.DISCORD_BOT_TOKEN) {
        const dotenv = require('dotenv');
        for (const file of ['.env', 'dashboard/.env.local']) dotenv.config({ path: path.join(__dirname, '..', file), quiet: true });
    }
    const token = process.env.DISCORD_TOKEN || process.env.DISCORD_BOT_TOKEN;
    if (!token) throw new Error('No DISCORD_TOKEN / DISCORD_BOT_TOKEN found.');
    return token;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function discord(token, method, route, body) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
        const res = await fetch(`${API}${route}`, {
            method,
            headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'DiscordBot (https://www.zigbot.in, 1.0)' },
            body: body ? JSON.stringify(body) : undefined
        });
        if (res.status === 429) {
            const wait = Number((await res.json().catch(() => ({}))).retry_after || 2);
            await sleep(Math.ceil(wait * 1000) + 250);
            continue;
        }
        const data = await res.json().catch(() => null);
        if (!res.ok) {
            const error = new Error(`${method} ${route.replace(/\d{17,20}/g, ':id')} -> ${res.status} ${data?.message || ''}`.trim());
            error.code = data?.code;
            throw error;
        }
        return data;
    }
    throw new Error(`${method} ${route} kept hitting the rate limit`);
}

async function main() {
    const send = process.argv.includes('--send');
    const token = loadToken();
    const me = await discord(token, 'GET', '/users/@me');
    const partials = await discord(token, 'GET', '/users/@me/guilds?limit=200');
    if (partials.length >= 200) console.warn('⚠️ 200+ servers: only the first 200 are covered.');
    const guilds = [];
    for (const g of partials) guilds.push(await discord(token, 'GET', `/guilds/${g.id}`));

    const sent = fs.existsSync(LOG_FILE) ? JSON.parse(fs.readFileSync(LOG_FILE, 'utf8')) : {};
    const owners = groupByOwner(guilds, { skipIds: [me.id] });
    // --only <ownerId>: just that owner (e.g. yourself first, as a preview).
    const onlyAt = process.argv.indexOf('--only');
    const only = onlyAt > -1 ? process.argv[onlyAt + 1] : null;
    if (only && !SNOWFLAKE.test(only)) throw new Error('--only needs a Discord user id.');
    const todo = owners.filter((o) => !sent[o.ownerId] && (!only || o.ownerId === only));

    const already = owners.filter((o) => sent[o.ownerId]).length;
    console.log(`ZiGBoT is in ${guilds.length} server(s), owned by ${owners.length} owner(s). Already messaged (sent log): ${already}. To message in this run: ${todo.length}${only ? ' (--only)' : ''}.\n`);
    for (const o of todo) console.log(`• owner ${o.ownerId}: ${o.servers.map(clean).join(', ')}`);
    if (todo[0]) console.log(`\n--- message (for the first owner) ---\n${buildOwnerMessage(todo[0])}\n--- end ---`);
    if (!send) {
        console.log('\nDry run: nothing was sent. Run with --send to send.');
        return;
    }

    const closed = [];
    let ok = 0;
    let failed = 0;
    for (const o of todo) {
        try {
            const channel = await discord(token, 'POST', '/users/@me/channels', { recipient_id: o.ownerId });
            await discord(token, 'POST', `/channels/${channel.id}/messages`, { content: buildOwnerMessage(o), allowed_mentions: { parse: [] } });
            sent[o.ownerId] = { at: new Date().toISOString(), servers: o.servers.length };
            ok += 1;
            console.log(`✅ sent to ${o.ownerId}`);
        } catch (error) {
            if (error.code === 50007) {
                closed.push(o.ownerId);
                sent[o.ownerId] = { at: new Date().toISOString(), skipped: 'DMs closed' };
                console.log(`🔒 ${o.ownerId}: DMs closed, skipped`);
            } else {
                failed += 1;
                console.log(`❌ ${o.ownerId}: ${error.message} (not logged: a re-run retries it)`);
            }
        }
        fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
        fs.writeFileSync(LOG_FILE, JSON.stringify(sent, null, 2));
        await sleep(GAP_MS);
    }
    console.log(`\nDone. Sent: ${ok}, DMs closed: ${closed.length}, failed: ${failed}.`);
}

if (require.main === module) {
    main().catch((error) => {
        console.error(`Stopped: ${error.message}`);
        process.exitCode = 1;
    });
}

module.exports = { buildOwnerMessage, groupByOwner };
