const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createServerClient } = require('../dashboard/node_modules/@supabase/ssr');
const { authCookieOptions } = require('../dashboard/lib/shared/authCookies');

const dashboard = path.join(__dirname, '..', 'dashboard');

test('auth cookies: the real Supabase client writes them HttpOnly, Secure and Lax', async () => {
    const written = [];
    const supabase = createServerClient('https://example.supabase.co', 'anon-key', {
        cookieOptions: authCookieOptions,
        cookies: { getAll: () => [], setAll: (cookies) => written.push(...cookies) }
    });
    // Starting a login stores the PKCE cookie, with no network call.
    await supabase.auth.signInWithOAuth({ provider: 'discord', options: { redirectTo: 'https://example.com/auth/callback', skipBrowserRedirect: true } });
    assert.ok(written.length > 0, 'a cookie was written');
    for (const { options } of written) {
        assert.equal(options.httpOnly, true);
        assert.equal(options.secure, true);
        assert.equal(options.sameSite, 'lax');
    }
});

test('auth cookies: both places that write them use the same options', () => {
    for (const file of ['middleware.js', path.join('lib', 'supabase', 'server.js')]) {
        assert.match(fs.readFileSync(path.join(dashboard, file), 'utf8'), /cookieOptions: authCookieOptions,/, file);
    }
});

test('auth cookies: no browser code can depend on reading the session', () => {
    const scan = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        return entry.isDirectory() ? scan(full) : full.endsWith('.js') ? [full] : [];
    });
    for (const file of [...scan(path.join(dashboard, 'app')), ...scan(path.join(dashboard, 'components'))]) {
        assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /createBrowserClient|document\.cookie/, file);
    }
});
