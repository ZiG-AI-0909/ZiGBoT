// Browser tests (no login needed). Run against a running dashboard:
//   npx next build && npx next start -p 3311     (or any deployed URL)
//   E2E_BASE_URL=http://localhost:3311 npx playwright test
// Locally the browser is the installed Microsoft Edge (no download);
// CI sets E2E_BROWSER=chromium after `npx playwright install chromium`.
const { defineConfig, devices } = require('@playwright/test');

const browser = process.env.E2E_BROWSER || 'msedge';
const desktop = browser === 'msedge' ? { ...devices['Desktop Edge'], channel: 'msedge' } : devices[`Desktop ${browser[0].toUpperCase()}${browser.slice(1)}`] || devices['Desktop Chrome'];

module.exports = defineConfig({
    testDir: './e2e',
    timeout: 30_000,
    retries: process.env.CI ? 1 : 0,
    reporter: process.env.CI ? [['list'], ['github']] : 'list',
    use: { baseURL: process.env.E2E_BASE_URL || 'http://localhost:3311', trace: 'retain-on-failure' },
    projects: [
        { name: `${browser}-desktop`, use: desktop },
        { name: `${browser}-mobile`, use: { ...devices['Pixel 7'], ...(browser === 'msedge' ? { channel: 'msedge' } : {}) } }
    ]
});
