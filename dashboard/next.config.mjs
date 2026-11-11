import path from 'node:path';
import { fileURLToPath } from 'node:url';
import seo from './lib/seo.js';
import ads from './lib/ads.js';
import csp from './lib/csp.js';

// One source for the policy: lib/csp.js (also used by middleware.js).
const cspDirectives = csp.staticCspDirectives({ dev: process.env.NODE_ENV === 'development' });

/** @type {import('next').NextConfig} */
const securityHeaders = [
    { key: 'X-Frame-Options', value: 'DENY' },
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
    { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' }
];
// The signed-in areas (lib/csp.js NONCE_PATHS) get a per-request nonce
// policy from middleware.js instead, so this static one skips them.
const staticCsp = [{ key: 'Content-Security-Policy', value: cspDirectives.join('; ') }];
const notNoncePaths = `/((?!${csp.NONCE_PATHS.map((p) => p.slice(1)).join('|')}).*)`;

// Public pages (lib/seo.js PUBLIC_PAGES) also allow Google AdSense
// (lib/ads.js). Everything else keeps the strict policy above.
const publicPageCsp = [{ key: 'Content-Security-Policy', value: ads.withAdSources(cspDirectives).join('; ') }];

const nextConfig = {
    reactStrictMode: true,
    poweredByHeader: false,
    // Always put <title>, description, canonical and sharing tags in <head>
    // (no metadata streaming into <body>): our metadata is static, and some
    // crawlers, link previews and audits only read <head>.
    htmlLimitedBots: /.*/,
    // The dashboard is self-contained (shared logic lives in ./lib/shared).
    outputFileTracingRoot: path.dirname(fileURLToPath(import.meta.url)),
    async headers() {
        // Private areas (lib/seo.js PRIVATE_PATHS) are never indexed, even
        // when a crawler reaches an API response or a redirect.
        const noindex = [{ key: 'X-Robots-Tag', value: 'noindex, nofollow' }];
        const privateRoutes = seo.PRIVATE_PATHS.flatMap((p) => [
            { source: p, headers: noindex },
            { source: `${p}/:path*`, headers: noindex }
        ]);
        // Later rules win for the same header, so the ad policy follows the default.
        const publicRoutes = seo.PUBLIC_PAGES.map((page) => ({ source: page.path, headers: publicPageCsp }));
        return [{ source: '/:path*', headers: securityHeaders }, { source: notNoncePaths, headers: staticCsp }, ...publicRoutes, ...privateRoutes];
    }
};

export default nextConfig;
