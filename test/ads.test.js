const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const ads = require('../dashboard/lib/ads');
const seo = require('../dashboard/lib/seo');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const PAGE_FILES = { '/': 'dashboard/app/page.js', '/commands': 'dashboard/app/commands/page.js', '/privacy': 'dashboard/app/privacy/page.js', '/terms': 'dashboard/app/terms/page.js', '/features/discord-bot': 'dashboard/app/features/discord-bot/page.js', '/features/ai-memory': 'dashboard/app/features/ai-memory/page.js', '/features/anti-nuke': 'dashboard/app/features/anti-nuke/page.js', '/features/studio': 'dashboard/app/features/studio/page.js', '/features/automation': 'dashboard/app/features/automation/page.js', '/pricing': 'dashboard/app/pricing/page.js' };

test('ads.txt names our AdSense publisher', () => {
    assert.equal(read('dashboard/public/ads.txt').trim(), 'google.com, pub-6170894801860429, DIRECT, f08c47fec0942fa0');
    assert.equal(ads.ADS_TXT, read('dashboard/public/ads.txt').trim());
    assert.match(ads.SCRIPT_URL, /client=ca-pub-6170894801860429$/);
});

test('the AdSense script is on the public pages and nowhere private', () => {
    assert.deepEqual(seo.PUBLIC_PAGES.map((p) => p.path).sort(), Object.keys(PAGE_FILES).sort());
    for (const file of Object.values(PAGE_FILES)) assert.match(read(file), /<AdSense \/>/, file);
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
    const app = path.join(__dirname, '..', 'dashboard', 'app');
    const users = walk(app).filter((f) => /\.js$/.test(f) && fs.readFileSync(f, 'utf8').includes('<AdSense'))
        .map((f) => path.relative(path.join(__dirname, '..'), f).split(path.sep).join('/')).sort();
    assert.deepEqual(users, Object.values(PAGE_FILES).sort(), 'no dashboard, admin, owner or welcome page loads ads');
    assert.doesNotMatch(read('dashboard/app/layout.js'), /AdSense|googlesyndication/);
});

test('only public pages get the ad CSP; private areas keep the strict one', async () => {
    const config = (await import(pathToFileURL(path.join(__dirname, '..', 'dashboard', 'next.config.mjs')).href)).default;
    const rules = await config.headers();
    const cspFor = (source) => rules.filter((r) => r.source === source).flatMap((r) => r.headers).filter((h) => h.key === 'Content-Security-Policy').pop()?.value;
    const strict = cspFor('/:path*');
    assert.doesNotMatch(strict, /googlesyndication/, 'default policy has no ad hosts');
    for (const page of seo.PUBLIC_PAGES) {
        const csp = cspFor(page.path);
        assert.match(csp, /script-src [^;]*https:\/\/\*\.googlesyndication\.com/, page.path);
        assert.match(csp, /frame-ancestors 'none'/, `${page.path} keeps the rest of the policy`);
    }
    const order = rules.map((r) => r.source);
    assert.ok(order.indexOf('/:path*') < order.indexOf('/'), 'the ad policy comes after (and overrides) the default');
    for (const p of seo.PRIVATE_PATHS) assert.equal(cspFor(p), undefined, `${p} has no ad policy`);
});
