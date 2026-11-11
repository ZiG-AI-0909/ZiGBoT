// End-to-end checks that need no login: public pages, navigation, broken
// links, protected-route guards, security headers and the nonce CSP.
const { test, expect } = require('@playwright/test');

const PUBLIC = ['/', '/commands', '/privacy', '/terms'];

// Collect what would mean "broken in a real browser": uncaught errors and
// Content-Security-Policy blocks (both directions: our policy too strict, or
// an injected script getting through would show as a missing block).
function watch(page) {
    const problems = [];
    page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
    page.on('console', (msg) => {
        if (msg.type() === 'error' && /Content Security Policy|Refused to (execute|load|apply|connect|frame)/i.test(msg.text())) problems.push(`csp: ${msg.text()}`);
    });
    return problems;
}

for (const path of PUBLIC) {
    test(`public page ${path} loads with no errors or CSP blocks`, async ({ page }) => {
        const problems = watch(page);
        const response = await page.goto(path);
        expect(response.status()).toBe(200);
        await expect(page).toHaveTitle(/ZiGBoT/);
        await page.waitForLoadState('networkidle');
        expect(problems).toEqual([]);
    });

    test(`public page ${path} has no horizontal scroll`, async ({ page }) => {
        await page.goto(path);
        await page.waitForLoadState('networkidle');
        // On failure, name what sticks out (clipped decorations don't count:
        // only real page width matters).
        const result = await page.evaluate(() => {
            const vw = document.documentElement.clientWidth;
            const culprits = [...document.querySelectorAll('body *')]
                .filter((el) => el.getBoundingClientRect().right > vw + 1 && getComputedStyle(el).position !== 'fixed')
                .slice(0, 5).map((el) => `${el.tagName.toLowerCase()}.${String(el.className || '').slice(0, 40)}`);
            return { overflow: document.documentElement.scrollWidth - vw, culprits };
        });
        expect(result.overflow, `page wider than the screen; elements past the edge: ${result.culprits.join(', ')}`).toBeLessThanOrEqual(1);
    });
}

// The hero ring spins forever; a rotated box is up to ~41% wider (at 45°)
// and browsers count it towards the page width, so on phones the page could
// be scrolled sideways at some moments only. Freeze it at the worst angle.
test('home page never gets wider than the screen while the hero ring spins', async ({ page }) => {
    await page.goto('/');
    await page.addStyleTag({ content: '.zig-ring { animation: none !important; transform: rotate(45deg) !important; }' });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
});

test('every internal link on the public pages resolves', async ({ page, request }, testInfo) => {
    // Same links in every browser: check them once, on the desktop project.
    test.skip(testInfo.project.name.endsWith('-mobile'), 'checked once, on desktop');
    test.setTimeout(90_000);
    const links = new Set();
    for (const path of PUBLIC) {
        // The links are in the server HTML; no need to wait for ads to load.
        await page.goto(path, { waitUntil: 'domcontentloaded' });
        for (const href of await page.$$eval('a[href^="/"]', (as) => as.map((a) => a.getAttribute('href')))) links.add(href.split('#')[0] || '/');
    }
    const broken = [];
    for (const href of links) {
        if (href.startsWith('/auth/')) continue; // starts the Discord login flow
        const res = await request.get(href, { maxRedirects: 0 });
        if (res.status() >= 400) broken.push(`${href} -> ${res.status()}`);
    }
    expect(broken).toEqual([]);
    expect(links.size).toBeGreaterThan(3);
});

test('signed-in page /welcome runs under the nonce policy with nothing blocked', async ({ page }) => {
    const problems = watch(page);
    const response = await page.goto('/welcome');
    expect(response.status()).toBe(200);
    const policy = response.headers()['content-security-policy'];
    expect(policy).toMatch(/'nonce-[^']+' 'strict-dynamic'/);
    await page.waitForLoadState('networkidle');
    // Next.js streams the page through inline scripts: if the nonce were
    // missing, they would be blocked and this would be undefined.
    expect(await page.evaluate(() => Array.isArray(self.__next_f))).toBe(true);
    expect(problems).toEqual([]);
});

test('an injected inline script is blocked on signed-in pages', async ({ page }) => {
    const problems = watch(page);
    await page.goto('/welcome');
    await page.waitForLoadState('networkidle');
    // The usual XSS shape: attacker markup with an inline event handler.
    // Without 'unsafe-inline' in effect, the browser refuses to run it.
    await page.evaluate(() => { document.body.insertAdjacentHTML('beforeend', '<img src="x" onerror="window.__xss = true">'); });
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => window.__xss === true)).toBe(false);
    expect(problems.some((p) => p.startsWith('csp:'))).toBe(true);
});

test('logged-out visitors are kept out of protected areas', async ({ page, request }) => {
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/$/);
    expect((await request.get('/admin')).status()).toBe(404);
    const api = await request.get('/api/guilds/123456789012345678/config');
    expect(api.status()).toBe(401);
    expect((await api.json()).error).toBeTruthy();
});

test('state-changing API calls from another site are refused', async ({ request }) => {
    // Saving settings is a PUT; the origin check runs before anything else.
    const res = await request.put('/api/guilds/123456789012345678/config', {
        headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
        data: {}
    });
    expect(res.status()).toBe(403);
});

test('security headers are present', async ({ request }) => {
    const headers = (await request.get('/terms')).headers();
    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['content-security-policy']).toMatch(/frame-ancestors 'none'/);
    expect(headers['content-security-policy']).toMatch(/object-src 'none'/);
    expect(headers['x-powered-by']).toBeUndefined();
});
