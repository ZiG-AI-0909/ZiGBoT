/**
 * Self-hosted runners: the owner runs ZiGBoT's small runner program on a
 * machine THEY control (VPS, PC, Raspberry Pi). It pairs once with a
 * short-lived code, then polls Studio for commands (deploy / start / stop /
 * restart), fetches the project bundle when deploying, and reports status
 * and logs back. Customer code runs only on that machine, never on ours.
 *
 * Secrets: the runner token is shown once and stored as a SHA-256 hash.
 * Pairing codes are hashed and expire after 15 minutes. The project's
 * encrypted environment variables are decrypted only for a paired runner's
 * deploy bundle (it needs them to start the bot) and never logged.
 */
const crypto = require('node:crypto');
const projectFiles = require('./files');

const ACTIONS = Object.freeze(['deploy', 'start', 'stop', 'restart']);
const STATES = Object.freeze(['unknown', 'installing', 'running', 'stopped', 'crashed']);
const LIMITS = Object.freeze({ runnersPerProject: 3, pairingMinutes: 15, logLinesPerReport: 100, logLineChars: 500, keptLogLines: 500, queuedCommands: 10 });
const PAIRING_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I

const sha256 = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');

/** 8-character pairing code, shown as XXXX-XXXX. */
function newPairingCode() {
    const bytes = crypto.randomBytes(8);
    const raw = Array.from(bytes, (b) => PAIRING_ALPHABET[b % PAIRING_ALPHABET.length]).join('');
    return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}
const normalizeCode = (code) => String(code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const hashPairingCode = (code) => sha256(`pair:${normalizeCode(code)}`);

/** Long-lived runner credential: "zbr_" + 43 url-safe chars. */
function newRunnerToken() { return `zbr_${crypto.randomBytes(32).toString('base64url')}`; }
const RUNNER_TOKEN = /^zbr_[A-Za-z0-9_-]{43}$/;
const hashRunnerToken = (token) => sha256(`runner:${token}`);

/** Bearer token from an Authorization header, or null. */
function bearer(header) {
    const m = /^Bearer\s+(\S+)$/i.exec(String(header || ''));
    return m && RUNNER_TOKEN.test(m[1]) ? m[1] : null;
}

function cleanName(name) {
    const s = String(name ?? '').replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
    return s || 'My server';
}

/** Validate a runner's report. Returns { value } or { error }. */
function validateReport(body) {
    const out = {};
    if (body?.commandId !== undefined && body.commandId !== null) {
        if (!/^\d{1,18}$/.test(String(body.commandId))) return { error: 'Invalid command id.' };
        out.commandId = Number(body.commandId);
        if (!['done', 'failed'].includes(body.status)) return { error: 'status must be done or failed.' };
        out.status = body.status;
        out.message = String(body.message ?? '').slice(0, 500);
    }
    if (body?.state !== undefined) {
        if (!STATES.includes(body.state)) return { error: 'Unknown state.' };
        out.state = body.state;
    }
    const logs = Array.isArray(body?.logs) ? body.logs.slice(0, LIMITS.logLinesPerReport) : [];
    out.logs = logs.map((l) => ({
        level: ['info', 'warn', 'error'].includes(l?.level) ? l.level : 'info',
        line: redact(String(l?.line ?? '')).slice(0, LIMITS.logLineChars)
    })).filter((l) => l.line);
    out.version = String(body?.version ?? '').slice(0, 20);
    return { value: out };
}

// Never store a token-looking string even if the bot prints one.
const SECRET_LIKE = [/[MN][A-Za-z\d_-]{23,25}\.[\w-]{6}\.[\w-]{27,}/g, /zbr_[A-Za-z0-9_-]{43}/g, /\b(sk-(?:proj-)?|gsk_|nvapi-|ghp_)[A-Za-z0-9_-]{16,}/g];
function redact(line) { return SECRET_LIKE.reduce((s, re) => s.replace(re, '[redacted]'), line); }

/** Deploy bundle for a paired runner: exportable files + env vars (already decrypted by the caller). */
function buildBundle({ project, files, env }) {
    return {
        project: { id: project.id, name: project.name, framework: project.framework },
        files: projectFiles.exportable(files).map((f) => ({ path: f.path, content: String(f.content ?? '') })),
        env: Object.fromEntries(Object.entries(env || {}).filter(([k]) => /^[A-Z][A-Z0-9_]{1,63}$/.test(k))),
        start: project.framework === 'discordpy'
            ? { install: ['pip', 'install', '-r', 'requirements.txt'], run: ['python', 'bot.py'] }
            : project.framework === 'discordjs-ts'
                ? { install: ['npm', 'install'], build: ['npm', 'run', 'build'], run: ['npm', 'start'] }
                : { install: ['npm', 'install'], run: ['npm', 'start'] }
    };
}

/** Online = seen in the last 60 s. */
const isOnline = (runner, now = Date.now()) => Boolean(runner?.last_seen_at) && now - new Date(runner.last_seen_at).getTime() < 60_000;

const publicRunner = (r, now = Date.now()) => ({
    id: r.id, name: r.name, status: r.status, state: r.state || 'unknown', online: isOnline(r, now),
    lastSeenAt: r.last_seen_at, platform: r.platform || null, version: r.version || null, createdAt: r.created_at
});

module.exports = { ACTIONS, STATES, LIMITS, newPairingCode, normalizeCode, hashPairingCode, newRunnerToken, hashRunnerToken, bearer, cleanName, validateReport, redact, buildBundle, isOnline, publicRunner, RUNNER_TOKEN };
