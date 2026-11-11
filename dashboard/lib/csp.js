/**
 * Content-Security-Policy, in ONE place (next.config.mjs, middleware.js and
 * test/csp.test.js use it). CommonJS like lib/seo.js and lib/ads.js.
 *
 * Two policies:
 *  - staticCsp(): every page, including the pre-built public pages (and,
 *    via lib/ads.js, AdSense on those). script-src keeps 'unsafe-inline'
 *    because a pre-built page cannot carry a per-request nonce.
 *  - nonceCsp(nonce): the signed-in areas (NONCE_PATHS), which render per
 *    request anyway. Scripts run only with this request's nonce, or when a
 *    nonce'd script loads them ('strict-dynamic': how Razorpay Checkout,
 *    added by the dashboard's own code, still loads). An injected inline
 *    <script> has no nonce and is blocked. 'unsafe-inline' and https: are
 *    ignored by every browser that understands nonces; they only keep very
 *    old browsers working.
 */

// Signed-in areas served with the nonce policy (middleware.js).
const NONCE_PATHS = Object.freeze(['/dashboard', '/admin', '/owner', '/welcome']);

const isNoncePath = (pathname) => NONCE_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));

function directives({ dev = false, script }) {
    return [
        "default-src 'self'",
        // *.razorpay.com: Razorpay Standard Checkout (loaded only when someone
        // pays) pulls its code, styles, fonts and icons from several Razorpay
        // hosts that change over time; blocking any of them makes rzp.open()
        // fail silently. The wildcard stays limited to Razorpay's own domain.
        "img-src 'self' data: blob: https://cdn.discordapp.com https://*.razorpay.com",
        "style-src 'self' 'unsafe-inline' https://*.razorpay.com",
        "font-src 'self' data: https://*.razorpay.com",
        // Next.js dev mode needs eval for hot reloading; production never gets it.
        `script-src ${script}${dev ? " 'unsafe-eval'" : ''}`,
        // The Checkout modal is an iframe served by Razorpay.
        'frame-src https://*.razorpay.com',
        "connect-src 'self' https://*.razorpay.com",
        "frame-ancestors 'none'",
        "base-uri 'self'",
        "object-src 'none'",
        "form-action 'self' https://discord.com https://*.supabase.co https://*.razorpay.com"
    ];
}

/** Directive list (['name value', ...]) for pages without a nonce. */
function staticCspDirectives({ dev = false } = {}) {
    return directives({ dev, script: "'self' 'unsafe-inline' https://*.razorpay.com" });
}

/** Header value for a signed-in page rendered with `nonce`. */
function nonceCsp(nonce, { dev = false } = {}) {
    if (!/^[A-Za-z0-9+/=_-]{16,}$/.test(String(nonce || ''))) throw new Error('nonceCsp needs a random nonce of 16+ base64 characters');
    return directives({ dev, script: `'self' 'nonce-${nonce}' 'strict-dynamic' https: 'unsafe-inline'` }).join('; ');
}

module.exports = { NONCE_PATHS, isNoncePath, staticCspDirectives, nonceCsp };
