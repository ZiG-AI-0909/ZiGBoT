// Dashboard redesign, Phase 1: sidebar navigation (components/AppShell.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', 'dashboard');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const shell = read('components', 'AppShell.js');

test('the dashboard and Studio use the sidebar shell; admin keeps its own layout', () => {
    assert.match(read('app', 'dashboard', 'layout.js'), /<AppShell contactUrl=\{PORTFOLIO_CONTACT_URL\}>/);
    assert.match(read('app', 'dashboard', 'layout.js'), /<FeedbackPrompt \/>/, 'existing feedback prompt kept');
    assert.match(read('app', 'studio', 'layout.js'), /<AppShell contactUrl=\{PORTFOLIO_CONTACT_URL\}>/);
    assert.doesNotMatch(read('app', 'admin', 'layout.js'), /AppShell/);
});

test('every sidebar link points at a page that exists', () => {
    const studioPart = shell.slice(shell.indexOf("parts[0] === 'studio'"), shell.indexOf("parts[0] === 'dashboard'"));
    const serverPart = shell.slice(shell.indexOf("parts[0] === 'dashboard'"), shell.indexOf("label: 'Help'"));
    const hrefs = (src) => [...src.matchAll(/href: [`']([^`']+)[`']/g)].map((m) => m[1]);
    const routes = [
        ...hrefs(shell).filter((h) => !h.startsWith('${base}')),
        ...hrefs(studioPart).map((h) => h.replace('${base}', '/studio/[projectId]')),
        ...hrefs(serverPart).map((h) => h.replace('${base}', '/dashboard/[guildId]'))
    ];
    routes.push('/studio/[projectId]', '/dashboard/[guildId]'); // the two `href: base` overview links
    assert.equal(routes.length, 13);
    for (const route of routes) assert.ok(fs.existsSync(path.join(ROOT, 'app', ...route.split('/').filter(Boolean), 'page.js')), route);
});

test('accessible and safe: aria-current, labelled toggles, Escape closes, POST logout, storage guarded', () => {
    assert.match(shell, /aria-current=\{active \? 'page' : undefined\}/);
    assert.match(shell, /aria-label="Open navigation" aria-expanded=\{open\}/);
    assert.match(shell, /aria-label=\{collapsed \? 'Expand sidebar' : 'Collapse sidebar'\}/);
    assert.match(shell, /e\.key === 'Escape'/);
    assert.match(shell, /<form action="\/auth\/logout" method="post">/);
    assert.match(shell, /skip-link/);
    assert.equal((shell.match(/window\.localStorage/g) || []).length, 2);
    assert.equal((shell.match(/try \{[^}]*window\.localStorage/g) || []).length, 2, 'every storage access in try/catch');
    const css = read('app', 'globals.css');
    assert.match(css, /@media \(max-width: 900px\)[\s\S]*\.app-shell\.is-open \.app-sidebar \{ transform: none; \}/, 'mobile drawer');
    assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.app-sidebar/);
    assert.match(css, /\.nav-link\.is-active::before/, 'active indicator');
});

test('context groups only appear for real ids (UUID project, snowflake server)', () => {
    assert.match(shell, /parts\[0\] === 'studio' && UUID\.test\(parts\[1\] \|\| ''\)/);
    assert.match(shell, /parts\[0\] === 'dashboard' && SNOWFLAKE\.test\(parts\[1\] \|\| ''\)/);
    assert.doesNotMatch(shell, /supabase|fetch\(/, 'navigation only: no data access in the shell');
});
