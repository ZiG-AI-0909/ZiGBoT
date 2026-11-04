/**
 * Attributes for every Supabase auth cookie (lib/supabase/server.js and
 * middleware.js must agree, or a session refresh would drop them).
 *
 *  - httpOnly: only server code uses the session; there is no browser Supabase
 *    client, so page scripts never need to read these cookies.
 *  - secure: HTTPS only. Off in `next dev`, which runs on plain http.
 *  - sameSite 'lax', not 'strict': the Discord login returns from another
 *    site, and a strict PKCE cookie would not be sent to /auth/callback.
 *    Cross-site writes are blocked by the same-origin check (lib/http.js).
 */
const authCookieOptions = Object.freeze({
    httpOnly: true,
    secure: process.env.NODE_ENV !== 'development',
    sameSite: 'lax'
});

module.exports = { authCookieOptions };
