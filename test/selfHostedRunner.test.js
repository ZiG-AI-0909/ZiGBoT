// Self-hosted runners: pairing, tokens, bundles, reports, the runner script, and no zip download.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const runner = require('../dashboard/lib/studio/runner');

const ROOT = path.join(__dirname, '..', 'dashboard');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const TOKEN = `${'MTA'.padEnd(26, 'x')}.Gh1jK2.${'a'.repeat(38)}`;

test('pairing codes: readable, random, normalised, hashed', () => {
    const codes = new Set(Array.from({ length: 200 }, () => runner.newPairingCode()));
    assert.equal(codes.size, 200);
    for (const c of codes) assert.match(c, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    assert.equal(runner.hashPairingCode('abcd-efgh'), runner.hashPairingCode('ABCDEFGH'));
    assert.match(runner.hashPairingCode('ABCD-EFGH'), /^[0-9a-f]{64}$/);
});

test('runner tokens: strong, hashed, only well-formed bearer tokens accepted', () => {
    const t = runner.newRunnerToken();
    assert.match(t, runner.RUNNER_TOKEN);
    assert.notEqual(runner.hashRunnerToken(t), t);
    assert.equal(runner.bearer(`Bearer ${t}`), t);
    for (const bad of ['', 'Bearer', `Basic ${t}`, 'Bearer zbr_short', `Bearer ${t} extra`]) assert.equal(runner.bearer(bad), null, bad);
});

test('deploy bundle: no .env or keys, env only valid names, fixed start commands per framework', () => {
    const b = runner.buildBundle({ project: { id: 'p', name: 'Bot', framework: 'discordjs' }, files: [{ path: 'src/index.js', content: 'x' }, { path: '.env', content: 'DISCORD_TOKEN=1' }, { path: 'key.pem', content: 'k' }], env: { DISCORD_TOKEN: 'abc', 'bad name': 'x' } });
    assert.deepEqual(b.files.map((f) => f.path), ['src/index.js']);
    assert.deepEqual(Object.keys(b.env), ['DISCORD_TOKEN']);
    assert.deepEqual(b.start, { install: ['npm', 'install'], run: ['npm', 'start'] });
    assert.deepEqual(runner.buildBundle({ project: { framework: 'discordpy' }, files: [], env: {} }).start.run, ['python', 'bot.py']);
    assert.ok(runner.buildBundle({ project: { framework: 'discordjs-ts' }, files: [], env: {} }).start.build);
});

test('reports: validated, capped, and secrets in logs are redacted', () => {
    const r = runner.validateReport({ commandId: '12', status: 'done', state: 'running', logs: [{ level: 'info', line: `logged in with ${TOKEN}` }, { level: 'weird', line: 'x' }, { line: '' }] });
    assert.equal(r.value.commandId, 12);
    assert.equal(r.value.logs.length, 2);
    assert.ok(!r.value.logs[0].line.includes(TOKEN));
    assert.match(r.value.logs[0].line, /\[redacted\]/);
    assert.equal(r.value.logs[1].level, 'info');
    assert.ok(runner.validateReport({ commandId: 'x' }).error);
    assert.ok(runner.validateReport({ commandId: 1, status: 'maybe' }).error);
    assert.ok(runner.validateReport({ state: 'hacked' }).error);
    assert.equal(runner.validateReport({ logs: Array.from({ length: 500 }, () => ({ line: 'a' })) }).value.logs.length, 100);
    assert.equal(runner.redact(`token ${runner.newRunnerToken()} here`), 'token [redacted] here');
});

test('runner API: token-guarded, bundle only during this runner\'s own deploy, pairing atomic and one-time', () => {
    const bundle = read('app', 'api', 'runner', 'bundle', 'route.js');
    assert.match(bundle, /requireRunner\(request\)/);
    assert.match(bundle, /cmd\.action !== 'deploy' \|\| cmd\.status !== 'sent'/);
    assert.match(bundle, /\.eq\('runner_id', r\.id\)/);
    assert.doesNotMatch(bundle, /console\.(log|error)/, 'secret values are never logged');
    for (const f of ['poll', 'report']) assert.match(read('app', 'api', 'runner', f, 'route.js'), /requireRunner\(request\)/);
    const pair = read('app', 'api', 'runner', 'pair', 'route.js');
    assert.match(pair, /\.eq\('status', 'pairing'\)\.gt\('pairing_expires_at', now\)/);
    assert.match(pair, /pairing_code_hash: null/);
    const server = read('lib', 'studio', 'runnerServer.js');
    assert.match(server, /data\.status !== 'paired'/, 'removed runners are locked out');
    const owner = read('app', 'api', 'studio', 'projects', '[projectId]', 'runners', 'route.js');
    assert.match(owner, /getOwnedProject\(supabase, ownerId, projectId\)/);
    assert.match(owner, /status: 'revoked', token_hash: null/);
    assert.match(owner, /pairing_code_hash: runner\.hashPairingCode\(code\)/);
    assert.ok(!fs.existsSync(path.join(ROOT, 'app', 'api', 'studio', 'runner')), 'runner API is outside /api/studio');
});

test('runner script: valid syntax, fixed command allow-list, no path escape, private config', () => {
    const file = path.join(ROOT, 'public', 'runner', 'zigbot-runner.mjs');
    const check = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    assert.equal(check.status, 0, check.stderr);
    const src = fs.readFileSync(file, 'utf8');
    assert.match(src, /const ALLOWED = \[/);
    assert.match(src, /if \(!ALLOWED\.includes\(key\)\) return Promise\.reject/);
    assert.match(src, /if \(!target\.startsWith\(APP \+ path\.sep\)\) throw/);
    assert.match(src, /mode: 0o600/);
    assert.doesNotMatch(src, /\beval\(|new Function/);
    const help = spawnSync(process.execPath, [file], { encoding: 'utf8', cwd: require('node:os').tmpdir() });
    assert.equal(help.status, 0);
    assert.match(help.stdout, /pair ABCD-EFGH --url/);
});

test('zip download is gone: no buttons, route answers 410', () => {
    assert.doesNotMatch(read('components', 'studio', 'Deployments.js'), /\/export`|Download project/);
    assert.doesNotMatch(read('app', 'studio', '[projectId]', 'page.js'), /\/export`|Download \.zip/);
    assert.match(read('app', 'api', 'studio', 'projects', '[projectId]', 'export', 'route.js'), /HttpError\(410/);
});
