#!/usr/bin/env node
/**
 * One-time DM from the ZiGBoT Team to every owner of a server ZiGBoT is in,
 * about the November 2026 platform update (Studio, dashboard, automations).
 *
 *   node scripts/announce-platform.js                     dry run: who + the message, sends NOTHING
 *   node scripts/announce-platform.js --send --only <id>  preview to one owner (yourself first)
 *   node scripts/announce-platform.js --send              everyone not messaged yet
 *
 * Same safety as scripts/announce-owners.js: REST only, one DM per owner,
 * no pings, a pause between DMs, Discord rate limits honoured, closed DMs
 * skipped, and logs/announce-platform-2026-11.json so nobody is messaged twice.
 */
const fs = require('node:fs');
const path = require('node:path');
const { groupByOwner, clean, listServers, discord, loadToken, sleep, SNOWFLAKE, GAP_MS } = require('./announce-owners');

const LOG_FILE = path.join(__dirname, '..', 'logs', 'announce-platform-2026-11.json');

function buildPlatformMessage({ servers }) {
    return [
        `👋 Hi from the **ZiGBoT Team**! You own ${listServers(servers)}, where ZiGBoT is installed. We just shipped our biggest update yet: ZiGBoT is now your server's AI command center.`,
        '',
        '🧭 **A new dashboard**',
        '• A sidebar with every server setting in one place: AI behaviour, roles, moderation, tickets, music and more.',
        '',
        '🛠️ **ZiGBoT Studio: build your own Discord bot**',
        '• Pick what your AI should build: **AI Coding**, **Workflow Automation** or **Prompt Engineering**.',
        '• A real code editor for discord.js or discord.py, with history and checks.',
        '• A visual workflow builder: drag blocks like "member joins → welcome → add role", and test them safely.',
        '• Connect your own Claude or OpenAI API key to turn a prompt into code or a workflow. You review every change before it is saved.',
        '• Run your bot on your own VPS or PC with the ZiGBoT runner.',
        '',
        '💎 **Premium automations**',
        '• Designing workflows is free. With ZiGBoT Premium they run live in your bot: on events and on a schedule.',
        '',
        'Your current server settings are unchanged. Take a look: <https://www.zigbot.in/dashboard>',
        '-# You are getting this one-time message because you own a server where ZiGBoT is installed. — ZiGBoT Team'
    ].join('\n');
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
    const onlyAt = process.argv.indexOf('--only');
    const only = onlyAt > -1 ? process.argv[onlyAt + 1] : null;
    if (only && !SNOWFLAKE.test(only)) throw new Error('--only needs a Discord user id.');
    const todo = owners.filter((o) => !sent[o.ownerId] && (!only || o.ownerId === only));

    console.log(`ZiGBoT is in ${guilds.length} server(s), owned by ${owners.length} owner(s). Already messaged: ${owners.length - owners.filter((o) => !sent[o.ownerId]).length}. To message now: ${todo.length}${only ? ' (--only)' : ''}.\n`);
    for (const o of todo) console.log(`• owner ${o.ownerId}: ${o.servers.map(clean).join(', ')}`);
    if (todo[0]) console.log(`\n--- message (${buildPlatformMessage(todo[0]).length} chars) ---\n${buildPlatformMessage(todo[0])}\n--- end ---`);
    if (!send) { console.log('\nDry run: nothing was sent.'); return; }

    let ok = 0; let closed = 0; let failed = 0;
    for (const o of todo) {
        try {
            const channel = await discord(token, 'POST', '/users/@me/channels', { recipient_id: o.ownerId });
            await discord(token, 'POST', `/channels/${channel.id}/messages`, { content: buildPlatformMessage(o), allowed_mentions: { parse: [] } });
            sent[o.ownerId] = { at: new Date().toISOString(), servers: o.servers.length };
            ok += 1; console.log(`✅ sent to ${o.ownerId}`);
        } catch (error) {
            if (error.code === 50007) { closed += 1; sent[o.ownerId] = { at: new Date().toISOString(), skipped: 'DMs closed' }; console.log(`🔒 ${o.ownerId}: DMs closed, skipped`); }
            else { failed += 1; console.log(`❌ ${o.ownerId}: ${error.message} (a re-run retries it)`); }
        }
        fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
        fs.writeFileSync(LOG_FILE, JSON.stringify(sent, null, 2));
        await sleep(GAP_MS);
    }
    console.log(`\nDone. Sent: ${ok}, DMs closed: ${closed}, failed: ${failed}.`);
}

if (require.main === module) main().catch((error) => { console.error(`Stopped: ${error.message}`); process.exitCode = 1; });

module.exports = { buildPlatformMessage };
