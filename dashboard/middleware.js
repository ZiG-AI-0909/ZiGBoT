import { NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';

// Refreshes the Supabase session cookie on navigation and keeps logged-out
// visitors out of /dashboard. Real authorization happens in each route.
export async function middleware(request) {
    let response = NextResponse.next({ request });
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !anon) return response;

    const supabase = createServerClient(url, anon, {
        cookies: {
            getAll() {
                return request.cookies.getAll();
            },
            setAll(cookiesToSet) {
                for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
                response = NextResponse.next({ request });
                for (const { name, value, options } of cookiesToSet) response.cookies.set(name, value, options);
            }
        }
    });
    const { data } = await supabase.auth.getUser();

    if (!data?.user && request.nextUrl.pathname.startsWith('/dashboard')) {
        const login = request.nextUrl.clone();
        login.pathname = '/';
        login.search = '';
        return NextResponse.redirect(login);
    }
    return response;
}

export const config = {
    matcher: ['/dashboard/:path*', '/api/guilds/:path*', '/admin/:path*', '/admin', '/api/admin/:path*', '/api/feedback/:path*', '/api/feedback']
};
