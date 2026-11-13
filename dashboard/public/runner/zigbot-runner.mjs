#!/usr/bin/env node
/**
 * ZiGBoT Studio self-hosted runner.
 *
 * Runs YOUR Studio bot on YOUR machine (VPS, PC, Raspberry Pi). No
 * dependencies; Node.js 18+. It talks to ZiGBoT Studio over HTTPS:
 *
 *   node zigbot-runner.mjs pair ABCD-EFGH --url https://your-zigbot-site
 *   node zigbot-runner.mjs start
 *
 * "pair" exchanges the one-time code from the Deployments page for a runner
 * token, saved in ./.zigbot-runner/config.json (readable only by you).
 * "start" keeps running: every few seconds it asks Studio for commands
 * (Deploy / Start / Stop / Restart), installs and runs the bot in
 * ./.zigbot-runner/app, and sends status and log lines back.
 * Stop it with Ctrl+C. Remove the runner on the Deployments page to cut it off.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const VERSION = '1.0.0';
const HOME = path.resolve(process.cwd(), '.zigbot-runner');
const CONFIG = path.join(HOME, 'config.json');
const APP = path.join(HOME, 'app');
const TOKEN_RE = /^zbr_[A-Za-z0-9_-]{43}$/;

// Only these programs may be started, and only with these exact arguments.
const ALLOWED = [
    ['npm', 'install'], ['npm', 'run', 'build'], ['npm', 'start'],
    ['pip', 'install', '-r', 'requirements.txt'], ['python', 'bot.py']
].map((a) => a.join(' '));

// Windows needs a shell to find npm.cmd / pip.exe. The command is one of the
// fixed ALLOWED strings above (no user input), passed as a single string.
function spawnAllowed(argv, options) {
    return process.platform === 'win32'
        ? spawn(argv.join(' '), { ...options, shell: true })
        : spawn(argv[0], argv.slice(1), options);
}

function log(...a) { console.log(`[zigbot-runner ${new Date().toISOString()}]`, ...a); }
function fail(msg) { console.error(`zigbot-runner: ${msg}`); process.exit(1); }

function loadConfig() {
    try {
        const c = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
        if (!TOKEN_RE.test(c.token) || !/^https:\/\//.test(c.url) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(c.url)) throw new Error('bad config');
        return c;
    } catch { return null; }
}

async function api(cfg, method, route, body) {
    const res = await fetch(`${cfg.url}/api/runner/${route}`, {
        method,
        headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json', 'User-Agent': `zigbot-runner/${VERSION}` },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30_000)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status });
    return data;
}

async function pair(code, url) {
    if (!code) fail('usage: node zigbot-runner.mjs pair ABCD-EFGH --url https://your-zigbot-site');
    if (!url || !(/^https:\/\//.test(url) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(url))) fail('give the site address with --url https://...');
    url = url.replace(/\/+$/, '');
    const res = await fetch(`${url}/api/runner/pair`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, platform: `${os.platform()} ${os.arch()} node${process.versions.node}`, version: VERSION })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) fail(data.error || `pairing failed (HTTP ${res.status})`);
    fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
    fs.writeFileSync(CONFIG, JSON.stringify({ url, token: data.token, runnerId: data.runnerId }, null, 2), { mode: 0o600 });
    log(`Paired as "${data.name}" for project "${data.project?.name}". Now run: node zigbot-runner.mjs start`);
}

// ------------------------------------------------------------- the bot process
let child = null;
let lastBundle = null;
let state = 'unknown';
const pending = [];
function capture(level, chunk) {
    for (const line of String(chunk).split(/\r?\n/)) if (line.trim()) { pending.push({ level, line: line.slice(0, 500) }); if (pending.length > 1000) pending.shift(); }
}

function run(argv, { env, capture: cap = true } = {}) {
    const key = argv.join(' ');
    if (!ALLOWED.includes(key)) return Promise.reject(new Error(`refusing to run: ${key}`));
    return new Promise((resolve, reject) => {
        const p = spawnAllowed(argv, { cwd: APP, env: { ...process.env, ...env }, windowsHide: true });
        if (cap) { p.stdout.on('data', (d) => capture('info', d)); p.stderr.on('data', (d) => capture('warn', d)); }
        p.on('error', reject);
        p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${key} exited with code ${code}`))));
    });
}

function safeJoin(rel) {
    const target = path.resolve(APP, rel);
    if (!target.startsWith(APP + path.sep)) throw new Error(`unsafe path in bundle: ${rel}`);
    return target;
}

function writeBundle(bundle) {
    fs.rmSync(APP, { recursive: true, force: true });
    fs.mkdirSync(APP, { recursive: true, mode: 0o700 });
    for (const f of bundle.files) {
        const target = safeJoin(f.path);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, f.content);
    }
    // Secrets live only in this .env (mode 600) and the bot's environment.
    const envText = Object.entries(bundle.env || {}).map(([k, v]) => `${k}=${JSON.stringify(String(v))}`).join('\n');
    fs.writeFileSync(path.join(APP, '.env'), `${envText}\n`, { mode: 0o600 });
}

function startBot() {
    if (!lastBundle) throw new Error('nothing deployed yet: press Deploy first');
    if (child) return;
    if (!ALLOWED.includes(lastBundle.start.run.join(' '))) throw new Error('refusing to run an unknown start command');
    // Own process group on Linux/macOS so stop can end npm AND the bot under it.
    child = spawnAllowed(lastBundle.start.run, { cwd: APP, env: { ...process.env, ...lastBundle.env }, windowsHide: true, detached: process.platform !== 'win32' });
    state = 'running';
    child.stdout.on('data', (d) => capture('info', d));
    child.stderr.on('data', (d) => capture('error', d));
    child.on('exit', (code, signal) => {
        child = null;
        if (state === 'running') { state = 'crashed'; capture('error', `bot exited (code ${code}${signal ? `, ${signal}` : ''})`); }
    });
}

function stopBot() {
    if (!child) { state = 'stopped'; return Promise.resolve(); }
    state = 'stopped';
    const p = child;
    // Kill the whole tree: npm → bot.
    const killTree = (signal) => {
        if (process.platform === 'win32') spawn('taskkill', ['/pid', String(p.pid), '/T', '/F'], { windowsHide: true });
        else process.kill(-p.pid, signal);
    };
    return new Promise((resolve) => {
        const t = setTimeout(() => { try { killTree('SIGKILL'); } catch { /* gone */ } resolve(); }, 8000);
        p.once('exit', () => { clearTimeout(t); resolve(); });
        try { killTree('SIGTERM'); } catch { clearTimeout(t); resolve(); }
    });
}

async function handle(cfg, cmd) {
    log(`command #${cmd.id}: ${cmd.action}`);
    try {
        if (cmd.action === 'deploy') {
            state = 'installing';
            const bundle = await api(cfg, 'GET', `bundle?command=${cmd.id}`);
            await stopBot();
            writeBundle(bundle);
            lastBundle = bundle;
            await run(bundle.start.install, { env: bundle.env });
            if (bundle.start.build) await run(bundle.start.build, { env: bundle.env });
            startBot();
        } else if (cmd.action === 'start') startBot();
        else if (cmd.action === 'stop') await stopBot();
        else if (cmd.action === 'restart') { await stopBot(); startBot(); }
        await api(cfg, 'POST', 'report', { commandId: cmd.id, status: 'done', message: `${cmd.action} ok`, state, logs: pending.splice(0, 100), version: VERSION });
    } catch (e) {
        if (state === 'installing') state = 'crashed';
        capture('error', e.message);
        await api(cfg, 'POST', 'report', { commandId: cmd.id, status: 'failed', message: e.message.slice(0, 500), state, logs: pending.splice(0, 100), version: VERSION }).catch(() => {});
    }
}

async function loop() {
    const cfg = loadConfig();
    if (!cfg) fail('not paired yet: node zigbot-runner.mjs pair ABCD-EFGH --url https://your-zigbot-site');
    log(`runner ${VERSION} started; talking to ${cfg.url}`);
    process.on('SIGINT', async () => { log('stopping bot...'); await stopBot(); process.exit(0); });
    let wait = 2000;
    for (;;) {
        try {
            if (pending.length) await api(cfg, 'POST', 'report', { state, logs: pending.splice(0, 100), version: VERSION });
            const { command, pollAfterMs } = await api(cfg, 'POST', 'poll', { state, version: VERSION });
            if (command) await handle(cfg, command);
            wait = Math.min(Math.max(Number(pollAfterMs) || 5000, 1000), 30000);
        } catch (e) {
            if (e.status === 401) { await stopBot(); fail(`${e.message}`); }
            log(`network problem: ${e.message}; retrying`);
            wait = Math.min(wait * 2, 60000);
        }
        await new Promise((r) => setTimeout(r, wait));
    }
}

const [, , cmd, ...rest] = process.argv;
const flag = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };
if (Number(process.versions.node.split('.')[0]) < 18) fail('Node.js 18 or newer is required.');
if (cmd === 'pair') await pair(rest[0], flag('--url'));
else if (cmd === 'start') await loop();
else console.log('ZiGBoT Studio runner\n  node zigbot-runner.mjs pair ABCD-EFGH --url https://your-zigbot-site\n  node zigbot-runner.mjs start');
