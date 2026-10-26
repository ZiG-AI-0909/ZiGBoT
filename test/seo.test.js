const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// Search and sharing metadata (dashboard/lib/seo.js) and how the pages use it.
const seo = require('../dashboard/lib/seo');
const landing = require('../dashboard/lib/landing');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const ORIGIN = 'https://zigbotai.vercel.app';
const PAGE_FILES = { '/': 'dashboard/app/page.js', '/commands': 'dashboard/app/commands/page.js', '/privacy': 'dashboard/app/privacy/page.js', '/terms': 'dashboard/app/terms/page.js' };

test('one canonical origin, and no placeholder domain anywhere in the site code', () => {
    assert.equal(seo.CANONICAL_ORIGIN, ORIGIN);
    const files = ['dashboard/lib/seo.js', 'dashboard/app/layout.js', 'dashboard/next.config.mjs', ...Object.values(PAGE_FILES)];
    for (const file of files) assert.doesNotMatch(read(file), /your new domain|\[zigbotai|example\.com|localhost/i, file);
    assert.match(read('dashboard/app/layout.js'), /metadataBase: new URL\(seo\.CANONICAL_ORIGIN\)/);
});

test('every public page: unique title and description, absolute canonical, matching Open Graph and Twitter', () => {
    const titles = new Set();
    const descriptions = new Set();
    for (const page of seo.PUBLIC_PAGES) {
        const meta = seo.pageMetadata(page.path);
        const canonical = `${ORIGIN}${page.path === '/' ? '/' : page.path}`;
        assert.equal(meta.alternates.canonical, canonical);
        assert.equal(meta.openGraph.url, canonical);
        assert.equal(meta.openGraph.title, meta.title);
        assert.equal(meta.twitter.card, 'summary_large_image');
        assert.equal(meta.openGraph.images[0].url, `${ORIGIN}/opengraph-image`);
        assert.deepEqual(meta.robots, { index: true, follow: true });
        assert.ok(meta.description.length >= 50 && meta.description.length <= 170, `${page.path} description length`);
        titles.add(meta.title);
        descriptions.add(meta.description);
        assert.match(read(PAGE_FILES[page.path]), new RegExp(`export const metadata = seo\\.pageMetadata\\('${page.path.replace('/', '\\/')}'\\);`), `${page.path} uses the shared metadata`);
    }
    assert.equal(titles.size, seo.PUBLIC_PAGES.length);
    assert.equal(descriptions.size, seo.PUBLIC_PAGES.length);
    assert.throws(() => seo.pageMetadata('/dashboard'), /No public page metadata/);
});

test('robots.txt: search crawlers (and GPTBot) get public pages only; private areas closed for everyone', () => {
    const { rules, sitemap } = seo.robotsRules();
    assert.deepEqual(rules.map((r) => r.userAgent), ['Googlebot', 'Bingbot', 'OAI-SearchBot', 'GPTBot', '*']);
    for (const rule of rules) {
        assert.equal(rule.allow, '/');
        assert.deepEqual(rule.disallow, ['/dashboard', '/owner', '/api', '/auth'], `${rule.userAgent} never reaches private areas`);
    }
    assert.equal(sitemap, `${ORIGIN}/sitemap.xml`);
});

test('sitemap: only canonical, indexable public pages', () => {
    const urls = seo.sitemapEntries(new Date(0)).map((e) => e.url);
    assert.deepEqual(urls, [`${ORIGIN}/`, `${ORIGIN}/commands`, `${ORIGIN}/privacy`, `${ORIGIN}/terms`]);
    for (const url of urls) assert.ok(!seo.PRIVATE_PATHS.some((p) => new URL(url).pathname.startsWith(p)));
});

test('private routes: noindex in metadata and an X-Robots-Tag header', async () => {
    assert.deepEqual(seo.PRIVATE_METADATA.robots.index, false);
    assert.match(read('dashboard/app/dashboard/layout.js'), /\.\.\.seo\.PRIVATE_METADATA/);
    assert.match(read('dashboard/app/owner/identity/page.js'), /robots: \{ index: false, follow: false \}/);
    const config = (await import(pathToFileURL(path.join(root, 'dashboard', 'next.config.mjs')).href)).default;
    const headers = await config.headers();
    for (const p of seo.PRIVATE_PATHS) {
        for (const source of [p, `${p}/:path*`]) {
            const entry = headers.find((h) => h.source === source);
            assert.ok(entry, `header rule for ${source}`);
            assert.deepEqual(entry.headers, [{ key: 'X-Robots-Tag', value: 'noindex, nofollow' }]);
        }
    }
    const site = headers.find((h) => h.source === '/:path*');
    assert.ok(site.headers.some((h) => h.key === 'Content-Security-Policy'), 'security headers unchanged');
    assert.ok(!site.headers.some((h) => h.key === 'X-Robots-Tag'), 'public pages are not noindexed');
});

test('JSON-LD only states what the homepage shows: no ratings, reviews, prices or counts', () => {
    const { features, faq } = landing.landingContent();
    const app = seo.softwareApplicationJsonLd({ description: landing.hero.pitch, features });
    assert.equal(app['@type'], 'SoftwareApplication');
    assert.equal(app.url, `${ORIGIN}/`);
    assert.equal(app.description, landing.hero.pitch);
    assert.deepEqual(app.featureList, features.map((f) => `${f.title}${f.badge ? ` (${f.badge})` : ''}`));
    for (const key of ['aggregateRating', 'review', 'offers', 'price', 'userInteractionCount', 'interactionStatistic']) assert.ok(!(key in app), `no ${key}`);
    const faqLd = seo.faqJsonLd(faq);
    assert.deepEqual(faqLd.mainEntity.map((q) => [q.name, q.acceptedAnswer.text]), faq.map((f) => [f.q, f.a]));
    // The page builds both from the same variables it renders.
    const page = read('dashboard/app/page.js');
    assert.match(page, /seo\.softwareApplicationJsonLd\(\{ description: landing\.hero\.pitch, features \}\)/);
    assert.match(page, /seo\.faqJsonLd\(faq\)/);
    assert.match(page, /\{faq\.map\(\(item\) => \(/, 'the same faq is rendered visibly');
    // Safe inside a <script> tag.
    assert.doesNotMatch(seo.jsonLdScript({ text: '</script><script>alert(1)</script>' }), /<\/script>|</);
});

test('metadata always goes in <head> (no streaming into <body>, which some crawlers and audits miss)', async () => {
    const config = (await import(pathToFileURL(path.join(root, 'dashboard', 'next.config.mjs')).href)).default;
    assert.ok(config.htmlLimitedBots instanceof RegExp);
    for (const ua of ['Mozilla/5.0 (Windows NT 10.0) Chrome/130.0', 'Mozilla/5.0 (compatible; Googlebot/2.1)', 'Mozilla/5.0 Chrome-Lighthouse', 'OAI-SearchBot/1.0']) {
        assert.ok(config.htmlLimitedBots.test(ua), ua);
    }
});

test('Google Search Console verification file is served from the site root, publicly', () => {
    // HTML-file method: https://zigbotai.vercel.app/google4f033dbcc41e6d42.html
    const file = 'dashboard/public/google4f033dbcc41e6d42.html';
    assert.equal(read(file), 'google-site-verification: google4f033dbcc41e6d42.html');
    assert.ok(!seo.PRIVATE_PATHS.some((p) => '/google4f033dbcc41e6d42.html'.startsWith(p)), 'not under a noindex/disallowed path');
});

test('Google Search Console verification meta tag is set site-wide from lib/seo.js', () => {
    assert.equal(seo.SITE_VERIFICATION.google, 'cWplGzZ-DLyFscyRzBmgugKqMVFaMEkEy8cwa4Zx33o');
    assert.match(read('dashboard/app/layout.js'), /verification: \{ google: seo\.SITE_VERIFICATION\.google \}/);
});
