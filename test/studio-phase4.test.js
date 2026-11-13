// ZiGBoT Studio Phase 4: Code Studio (editor backend helpers, static checks, diff).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const files = require('../dashboard/lib/studio/files');
const checks = require('../dashboard/lib/studio/checks');
const { diffLines } = require('../dashboard/lib/studio/diff');
const { generateProject } = require('../dashboard/lib/studio/generators');

const ROOT = path.join(__dirname, '..');
const API = path.join(ROOT, 'dashboard', 'app', 'api', 'studio', 'projects', '[projectId]');
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');

test('file writes: traversal, absolute paths, secrets and >500 KB are refused', () => {
    for (const bad of ['../etc/passwd', 'a/../../b', '/abs/x.js', 'C:x.js', 'a b.js', '']) assert.ok(files.validateFileWrite(bad, 'x').error, bad);
    for (const secret of ['.env', 'src/.env', '.env.local', 'key.pem', 'id_rsa']) assert.match(files.validateFileWrite(secret, 'x').error, /Secret files/, secret);
    assert.equal(files.validateFileWrite('.env.example', 'A=').path, '.env.example');
    assert.match(files.validateFileWrite('big.txt', 'x'.repeat(512001)).error, /500 KB/);
    assert.ok(files.validateFileWrite('ok.txt', 'x'.repeat(500 * 1024)).path);
    assert.match(files.validateFileWrite('a.js', { evil: 1 }).error, /text/);
});

test('search: names and lines, capped, short queries ignored', () => {
    const fx = [{ path: 'src/hello.js', content: 'const a = 1;\nconsole.log("Hello")' }, { path: 'README.md', content: 'hello world' }];
    assert.deepEqual(files.searchFiles(fx, 'h'), []);
    const hits = files.searchFiles(fx, 'HELLO');
    assert.deepEqual(hits.map((h) => `${h.path}:${h.line}`), ['src/hello.js:0', 'src/hello.js:2', 'README.md:1']);
    assert.equal(files.searchFiles([{ path: 'x', content: 'ab\n'.repeat(500) }], 'ab').length, 100);
});

test('diff: added, removed and unchanged lines', () => {
    const d = diffLines('a\nb\nc', 'a\nc\nd');
    assert.deepEqual(d, [{ type: 'same', text: 'a' }, { type: 'del', text: 'b' }, { type: 'same', text: 'c' }, { type: 'add', text: 'd' }]);
    assert.deepEqual(diffLines('x', 'x'), [{ type: 'same', text: 'x' }]);
});

test('checks: generated projects pass; syntax errors and leaks are found without running anything', () => {
    for (const framework of ['discordjs', 'discordjs-ts', 'discordpy']) {
        const project = generateProject({ framework, template: 'blank', name: 'Check bot' });
        const fx = project.files || project;
        for (const id of Object.keys(checks.CHECKS)) {
            const r = checks.runCheck(id, fx, framework);
            if (id !== 'lint') assert.equal(r.ok, true, `${framework} ${id}: ${JSON.stringify(r.problems.slice(0, 3))}`);
        }
    }
    globalThis.__studioRan = false;
    const evil = [{ path: 'src/index.js', content: 'globalThis.__studioRan = true;\nfunction (' }, { path: 'package.json', content: '{bad' }];
    const syntax = checks.runCheck('syntax', evil, 'discordjs');
    assert.equal(syntax.ok, false);
    assert.ok(syntax.problems.some((p) => p.path === 'src/index.js' && p.line === 2));
    assert.ok(syntax.problems.some((p) => p.path === 'package.json'));
    assert.equal(globalThis.__studioRan, false, 'parsed, never executed');
    const token = `${'MTA'.padEnd(26, 'x')}.Gh1jK2.${'a'.repeat(38)}`;
    const lint = checks.runCheck('lint', [{ path: 'src/a.js', content: `const t = "${token}";\neval("1")` }], 'discordjs');
    assert.deepEqual(lint.problems.map((p) => p.rule), ['no-hardcoded-token', 'no-eval']);
    assert.ok(!JSON.stringify(lint).includes(token), 'the token itself is never echoed back');
    assert.deepEqual(checks.NOT_AVAILABLE.map((c) => c.id), ['test', 'install']);
    assert.throws(() => checks.runCheck('shell', [], 'discordjs'));
    assert.doesNotMatch(read(ROOT, 'dashboard', 'lib', 'studio', 'checks.js'), /child_process|require\('vm'\)|eval\(f\.|Function\(f\./);
});

test('routes: every Phase 4 route checks ownership; env never returns values', () => {
    for (const r of ['file', 'search', 'versions', 'env', 'checks']) {
        const src = read(API, r, 'route.js');
        assert.match(src, /requireStudioUser/, r);
        if (r !== 'checks') assert.match(src, /getOwnedProject/, r);
        assert.doesNotMatch(src, /child_process|\beval\(/, r);
    }
    const env = read(API, 'env', 'route.js');
    assert.doesNotMatch(env, /decryptSecret|ciphertext/, 'values are never decrypted or selected for answers');
    assert.match(env, /DISCORD_TOKEN/);
    assert.doesNotMatch(env, /console\.(log|error)/);
    const file = read(API, 'file', 'route.js');
    assert.match(file, /validateFileWrite/);
    assert.match(file, /studio_file_versions/, 'saves take a snapshot');
    const ui = read(ROOT, 'dashboard', 'components', 'studio', 'CodeStudio.js');
    assert.match(ui, /\/monaco\/vs/, 'Monaco served locally, not from a CDN');
});
