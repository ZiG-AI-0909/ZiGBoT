/**
 * Code Studio "Checks" (Phase 4): fixed, STATIC-ONLY analysis of a
 * project's files. Nothing here runs customer code: JavaScript and
 * TypeScript are only parsed (TypeScript's parser, no type-check, no
 * emit), JSON is parsed, and Python gets text-level checks only (there is
 * no Python interpreter on the server). Running tests or installing
 * packages needs the Phase 7 sandbox: NOT AVAILABLE.
 */
const { isSafePath } = require('./generators');

const REQUIRED = {
    discordjs: ['package.json', 'src/index.js', 'src/config.js', '.env.example'],
    'discordjs-ts': ['package.json', 'tsconfig.json', 'src/index.ts', 'src/config.ts', '.env.example'],
    discordpy: ['requirements.txt', 'bot.py', 'config.py', '.env.example']
};
const TOKEN_LIKE = /[MN][A-Za-z\d_-]{23,25}\.[\w-]{6}\.[\w-]{27,}/;

let ts = null;
function typescript() {
    if (!ts) ts = require('typescript');
    return ts;
}

/** Validate structure: required files exist, paths are safe, no committed secrets. */
function validateStructure(files, framework) {
    const problems = [];
    const paths = new Set(files.map((f) => f.path));
    for (const required of REQUIRED[framework] || []) if (!paths.has(required)) problems.push({ path: required, message: 'Required file is missing.' });
    for (const f of files) {
        if (!isSafePath(f.path)) problems.push({ path: f.path, message: 'Unsafe file path.' });
        if (/(^|\/)\.env$/.test(f.path)) problems.push({ path: f.path, message: 'A real .env file is in the project: keep secrets in Studio\'s encrypted environment variables instead.' });
    }
    return problems;
}

/** Syntax check: parse only. Returns [{ path, line, message }]. */
function syntaxCheck(files) {
    const problems = [];
    for (const f of files) {
        if (f.path.endsWith('.json')) {
            try { JSON.parse(f.content); } catch (e) { problems.push({ path: f.path, line: 1, message: `Invalid JSON: ${e.message}` }); }
        } else if (/\.(c|m)?[jt]s$/.test(f.path)) {
            const t = typescript();
            const kind = f.path.endsWith('.ts') ? t.ScriptKind.TS : t.ScriptKind.JS;
            const source = t.createSourceFile(f.path, f.content, t.ScriptTarget.Latest, true, kind);
            for (const d of source.parseDiagnostics || []) {
                const { line } = source.getLineAndCharacterOfPosition(d.start || 0);
                problems.push({ path: f.path, line: line + 1, message: t.flattenDiagnosticMessageText(d.messageText, ' ') });
            }
        } else if (f.path.endsWith('.py')) {
            const lines = f.content.split('\n');
            lines.forEach((line, i) => {
                if (/^\t+ +| +\t/.test(line)) problems.push({ path: f.path, line: i + 1, message: 'Mixed tabs and spaces in indentation.' });
            });
            const opened = (f.content.match(/[([{]/g) || []).length;
            const closed = (f.content.match(/[)\]}]/g) || []).length;
            if (opened !== closed) problems.push({ path: f.path, line: 1, message: 'Unbalanced brackets (text check only; full Python syntax checks are not available on the server).' });
        }
    }
    return problems;
}

/** Lint: a few fixed, framework-neutral rules. */
function lint(files) {
    const problems = [];
    for (const f of files) {
        if (!/\.(js|ts|py|json|md|txt)$/.test(f.path) && !f.path.endsWith('.env.example')) continue;
        f.content.split('\n').forEach((line, i) => {
            if (TOKEN_LIKE.test(line)) problems.push({ path: f.path, line: i + 1, rule: 'no-hardcoded-token', message: 'This looks like a Discord bot token. Move it to the encrypted environment variables.' });
            if (/\b(eval|new Function)\s*\(/.test(line) && !f.path.endsWith('.md')) problems.push({ path: f.path, line: i + 1, rule: 'no-eval', message: 'eval / new Function runs arbitrary code; avoid it.' });
            if (line.length > 200) problems.push({ path: f.path, line: i + 1, rule: 'max-line-length', message: 'Line is longer than 200 characters.' });
            if (/[ \t]+$/.test(line)) problems.push({ path: f.path, line: i + 1, rule: 'no-trailing-spaces', message: 'Trailing whitespace.' });
            if (/@everyone|@here/.test(line) && /\.(js|ts|py)$/.test(f.path)) problems.push({ path: f.path, line: i + 1, rule: 'no-mass-mention', message: 'Mass mentions in code; make sure allowedMentions blocks them.' });
        });
    }
    return problems;
}

const CHECKS = Object.freeze({
    structure: { label: 'Validate structure', run: (files, framework) => validateStructure(files, framework) },
    syntax: { label: 'Syntax check', run: (files) => syntaxCheck(files) },
    lint: { label: 'Lint', run: (files) => lint(files) }
});
const NOT_AVAILABLE = Object.freeze([
    { id: 'test', label: 'Run tests', reason: 'Needs an isolated sandbox to run your code (planned with hosting).' },
    { id: 'install', label: 'npm install / pip install', reason: 'Installing packages runs third-party code; it needs the sandbox too.' }
]);

function runCheck(id, files, framework) {
    const check = CHECKS[id];
    if (!check) throw new Error('Unknown check.');
    const problems = check.run(files, framework).slice(0, 200);
    return { id, label: check.label, ok: problems.length === 0, problems };
}

module.exports = { CHECKS, NOT_AVAILABLE, runCheck, validateStructure, syntaxCheck, lint };
