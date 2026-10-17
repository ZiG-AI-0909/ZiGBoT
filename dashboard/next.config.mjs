import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** @type {import('next').NextConfig} */
const securityHeaders = [
    { key: 'X-Frame-Options', value: 'DENY' },
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
    { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
    {
        key: 'Content-Security-Policy',
        value: [
            "default-src 'self'",
            // *.razorpay.com: Razorpay Standard Checkout (loaded only when someone
            // pays) pulls its code, styles, fonts and icons from several Razorpay
            // hosts (checkout.razorpay.com, checkout-static-next.razorpay.com,
            // cdn.razorpay.com, api.razorpay.com, lumberjack.razorpay.com, ...)
            // that change over time; blocking any of them makes rzp.open() fail
            // silently. The wildcard stays limited to Razorpay's own domain.
            "img-src 'self' data: blob: https://cdn.discordapp.com https://*.razorpay.com",
            "style-src 'self' 'unsafe-inline' https://*.razorpay.com",
            "font-src 'self' data: https://*.razorpay.com",
            // Next.js dev mode needs eval for hot reloading; production never gets it.
            process.env.NODE_ENV === 'development'
                ? "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://*.razorpay.com"
                : "script-src 'self' 'unsafe-inline' https://*.razorpay.com",
            // The Checkout modal is an iframe served by Razorpay.
            "frame-src https://*.razorpay.com",
            "connect-src 'self' https://*.razorpay.com",
            "frame-ancestors 'none'",
            "base-uri 'self'",
            "form-action 'self' https://discord.com https://*.supabase.co https://*.razorpay.com"
        ].join('; ')
    }
];

const nextConfig = {
    reactStrictMode: true,
    poweredByHeader: false,
    // The dashboard is self-contained (shared logic lives in ./lib/shared).
    outputFileTracingRoot: path.dirname(fileURLToPath(import.meta.url)),
    async headers() {
        return [{ source: '/:path*', headers: securityHeaders }];
    }
};

export default nextConfig;
