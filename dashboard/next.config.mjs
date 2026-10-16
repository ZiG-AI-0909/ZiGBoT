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
            "img-src 'self' https://cdn.discordapp.com https://cdn.razorpay.com data:",
            "style-src 'self' 'unsafe-inline'",
            // Next.js dev mode needs eval for hot reloading; production never gets it.
            // checkout.razorpay.com: Razorpay Standard Checkout (loaded only when someone pays).
            process.env.NODE_ENV === 'development'
                ? "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://checkout.razorpay.com"
                : "script-src 'self' 'unsafe-inline' https://checkout.razorpay.com",
            // The Checkout modal is an iframe served by Razorpay.
            "frame-src https://api.razorpay.com https://checkout.razorpay.com",
            "connect-src 'self' https://api.razorpay.com https://lumberjack.razorpay.com",
            "frame-ancestors 'none'",
            "base-uri 'self'",
            "form-action 'self' https://discord.com https://*.supabase.co"
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
