// ZIGBOT-008: Content-Security-Policy (dashboard/lib/csp.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const csp = require('../dashboard/lib/csp');
const ads = require('../dashboard/lib/ads');

const directive = (policy, name) => policy.split('; ').find((d) => d.startsWith(`${name} `));
const NONCE = 'MDEyMzQ1Njc4OWFiY2RlZg==';

test('signed-in pages: scripts need this request\'s nonce (strict-dynamic)', () => {
    const policy = csp.nonceCsp(NONCE);
    const script = directive(policy, 'script-src');
    assert.match(script, new RegExp(`'nonce-${NONCE}'`));
    assert.match(script, /'strict-dynamic'/);
    assert.doesNotMatch(script, /unsafe-eval/);
    assert.equal(directive(policy, 'frame-ancestors'), "frame-ancestors 'none'");
    assert.equal(directive(policy, 'object-src'), "object-src 'none'");
    assert.equal(directive(policy, 'base-uri'), "base-uri 'self'");
    assert.match(directive(policy, 'frame-src'), /https:\/\/\*\.razorpay\.com/, 'Razorpay Checkout iframe still allowed');
});

test('nonceCsp refuses a missing or weak nonce', () => {
    for (const bad of [undefined, '', 'short', "x' 'unsafe-eval"]) assert.throws(() => csp.nonceCsp(bad), /nonce/);
});

test('dev mode adds unsafe-eval only when asked', () => {
    assert.match(directive(csp.nonceCsp(NONCE, { dev: true }), 'script-src'), /'unsafe-eval'/);
    assert.match(csp.staticCspDirectives({ dev: true }).find((d) => d.startsWith('script-src')), /'unsafe-eval'/);
    assert.doesNotMatch(csp.staticCspDirectives().join('; '), /unsafe-eval/);
});

test('public pages keep the static policy, and AdSense sources are added to it', () => {
    const base = csp.staticCspDirectives();
    assert.match(base.find((d) => d.startsWith('script-src')), /'self' 'unsafe-inline' https:\/\/\*\.razorpay\.com/);
    const withAds = ads.withAdSources(base).join('; ');
    assert.match(directive(withAds, 'script-src'), /googlesyndication/);
    assert.doesNotMatch(directive(withAds, 'script-src'), /nonce-/);
});

test('nonce paths cover the signed-in areas and nothing public', () => {
    for (const p of ['/dashboard', '/dashboard/123', '/admin', '/admin/feedback/9', '/owner/identity', '/welcome']) assert.equal(csp.isNoncePath(p), true, p);
    for (const p of ['/', '/commands', '/privacy', '/terms', '/api/health', '/administrator', '/dashboards']) assert.equal(csp.isNoncePath(p), false, p);
});
