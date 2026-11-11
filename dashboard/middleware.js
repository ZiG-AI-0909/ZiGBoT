import { NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { authCookieOptions } from './lib/shared/authCookies';
import csp from './lib/csp';

// Paths whose Supabase session cookie is refreshed here (unchanged from
// before). Real authorization still happens in each route.
const SESSION_PATHS = ['/dashboard', '/admin', '/api/guilds', '/api/admin', '/api/feedback'];
const underAny = (pathname, prefixes) => prefixes.some((p) => pathname === p || pathname.startsWith(`${p}/`));

// 1. Signed-in areas (lib/csp.js NONCE_PATHS) get a fresh script nonce per
//    request. Next.js reads it from the request's Content-Security-Policy
//    header and puts it on its own scripts; the same policy goes on the
//    response.
// 2. Refreshes the Supabase session cookie and keeps logged-out visitors out
//    of /dashboard.
export async function middleware(request) {
    const { pathname } = request.nextUrl;
    const policy = csp.isNoncePath(pathname)
        ? csp.nonceCsp(btoa(crypto.randomUUID()), { dev: process.env.NODE_ENV === 'development' })
        : null;

    // Pass the request on, with the nonce policy when there is one. Built
    // fresh each time so cookies Supabase refreshed are forwarded too.
    const forward = () => {
        if (!policy) return NextResponse.next({ request });
        const headers = new Headers(request.headers);
        headers.set('content-security-policy', policy);
        return NextResponse.next({ request: { headers } });
    };
    const finish = (response) => {
        if (policy) response.headers.set('Content-Security-Policy', policy);
        return response;
    };

    let response = forward();
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !anon || !underAny(pathname, SESSION_PATHS)) return finish(response);

    const supabase = createServerClient(url, anon, {
        cookieOptions: authCookieOptions,
        cookies: {
            getAll() {
                return request.cookies.getAll();
            },
            setAll(cookiesToSet) {
                for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
                response = forward();
                for (const { name, value, options } of cookiesToSet) response.cookies.set(name, value, options);
            }
        }
    });
    const { data } = await supabase.auth.getUser();

    if (!data?.user && pathname.startsWith('/dashboard')) {
        const login = request.nextUrl.clone();
        login.pathname = '/';
        login.search = '';
        return NextResponse.redirect(login);
    }
    return finish(response);
}

export const config = {
    matcher: [
        '/dashboard/:path*', '/admin/:path*', '/admin', '/owner/:path*', '/owner', '/welcome',
        '/api/guilds/:path*', '/api/admin/:path*', '/api/feedback/:path*', '/api/feedback'
    ]
};
