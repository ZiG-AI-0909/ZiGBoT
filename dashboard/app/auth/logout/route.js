import { NextResponse } from 'next/server';
import shared from '@/lib/shared';
import { createUserClient } from '@/lib/supabase/server';
import { env } from '@/lib/env';

export const dynamic = 'force-dynamic';

// POST only (a GET link could be triggered cross-site to log people out).
export async function POST(request) {
    const origin = env.siteUrl || new URL(request.url).origin;
    const sameOrigin = shared.isSameOrigin({
        origin: request.headers.get('origin'),
        host: request.headers.get('x-forwarded-host') || request.headers.get('host'),
        allowedOrigins: env.siteUrl ? [env.siteUrl] : []
    });
    if (!sameOrigin) return NextResponse.json({ error: 'Cross-origin request blocked.' }, { status: 403 });
    const supabase = await createUserClient();
    await supabase.auth.signOut();
    return NextResponse.redirect(`${origin}/`, { status: 303 });
}
