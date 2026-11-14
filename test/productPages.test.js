// Public product pages (/features/*) and /pricing: honest, linked, indexable.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PRODUCT_PAGES, PRICING } = require('../dashboard/lib/productPages');
const seo = require('../dashboard/lib/seo');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const copyOf = (p) => [p.title, p.description, p.h1, p.lead, ...p.sections.flatMap((s) => [s.h2, s.text, ...s.points]), ...(p.faq || []).flatMap((f) => [f.q, f.a])].join('\n');

test('the six product pages from the brief exist, each with its own route and metadata', () => {
    assert.deepEqual(PRODUCT_PAGES.map((p) => p.slug), ['discord-bot', 'ai-memory', 'anti-nuke', 'studio', 'automation']);
    for (const p of PRODUCT_PAGES) {
        const file = `dashboard/app/features/${p.slug}/page.js`;
        assert.match(read(file), new RegExp(`seo\\.pageMetadata\\('${p.path.replace(/\//g, '\\/')}'\\)`), file);
        assert.match(read(file), new RegExp(`<ProductPage slug="${p.slug}" />`));
        assert.ok(seo.PUBLIC_PAGES.some((x) => x.path === p.path), `${p.path} is public and in the sitemap`);
    }
    assert.ok(seo.PUBLIC_PAGES.some((x) => x.path === '/pricing'));
    assert.match(read('dashboard/app/pricing/page.js'), /seo\.pageMetadata\('\/pricing'\)/);
});

test('every claim names source files that exist (no features that are not built)', () => {
    for (const p of PRODUCT_PAGES) {
        for (const s of p.sections) {
            assert.ok(s.sources.length, `${p.slug}: ${s.h2}`);
            for (const f of s.sources) assert.ok(fs.existsSync(path.join(root, f)), `${p.slug}: ${f}`);
        }
    }
    for (const f of PRICING.sources) assert.ok(fs.existsSync(path.join(root, f)));
});

test('no fake stats, testimonials, ratings or unprovable superlatives', () => {
    const forbidden = [/trusted by/i, /testimonial/i, /\b\d[\d,.]*\s*[kKmM]?\+?\s*(servers|users|members|guilds)\b/i, /★|\brating\b/i, /\bthe best\b/i, /\bbest (discord|bot|ai)\b/i, /#1\b/, /\bfirst[- ]of[- ]its[- ]kind\b/i, /\bthe only\b/i];
    for (const p of PRODUCT_PAGES) for (const re of forbidden) assert.doesNotMatch(copyOf(p), re, `${p.slug} ${re}`);
    for (const re of forbidden) assert.doesNotMatch([...PRICING.free, ...PRICING.premium].join('\n'), re);
});

test('pricing tells the truth about cancellation and never hard-codes a price', () => {
    const page = read('dashboard/app/pricing/page.js');
    assert.match(page, /Premium stays active until the end of the period you paid for/);
    assert.match(page, /env\.premiumPriceLabels/);
    assert.doesNotMatch(page, /₹[1-9]/, 'paid prices come from configuration (only Free\'s ₹0 is literal)');
    assert.match(page, /Always free: moderation, Anti-Nuke, and the memory and privacy controls\./);
});

test('linked from every page (footer) and to each other', () => {
    const footer = read('dashboard/components/SiteFooter.js');
    assert.match(footer, /productPages\.PRODUCT_PAGES\.map/);
    assert.match(footer, /href="\/pricing"/);
    assert.match(read('dashboard/components/ProductPage.js'), /aria-label="Other ZiGBoT products"/);
    assert.match(read('dashboard/components/ProductPage.js'), /<main className="product-page">/);
});
