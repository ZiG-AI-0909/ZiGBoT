import { NextResponse } from 'next/server';
import { createUserClient } from '@/lib/supabase/server';
import { env } from '@/lib/env';

export const dynamic = 'force-dynamic';

// GET /auth/login -> Discord OAuth via Supabase Auth (PKCE). Scope "guilds"
// lets the callback list the servers the user can manage.
export async function GET(request) {
    const origin = env.siteUrl || new URL(request.url).origin;
    const supabase = await createUserClient();
    const { data, error } = await supabase.auth.signInWithOAuth({
        provider: 'discord',
        options: { redirectTo: `${origin}/auth/callback`, scopes: 'identify guilds' }
    });
    if (error || !data?.url) {
        console.error('[auth] signInWithOAuth failed:', error?.message);
        return NextResponse.redirect(`${origin}/?error=login_failed`, { status: 303 });
    }
    return NextResponse.redirect(data.url, { status: 303 });
}
