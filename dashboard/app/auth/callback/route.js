import { NextResponse } from 'next/server';
import shared from '@/lib/shared';
import { createUserClient, createServiceClient } from '@/lib/supabase/server';
import { getUserGuilds } from '@/lib/discord';
import { env } from '@/lib/env';

const { discordIdFromUser, canManageFromOAuthGuild, SNOWFLAKE } = shared;

export const dynamic = 'force-dynamic';

export async function GET(request) {
    const url = new URL(request.url);
    const origin = env.siteUrl || url.origin;
    const code = url.searchParams.get('code');
    if (!code) return NextResponse.redirect(`${origin}/?error=missing_code`, { status: 303 });

    const supabase = await createUserClient();
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (error || !data?.user) {
        console.error('[auth] code exchange failed:', error?.message);
        return NextResponse.redirect(`${origin}/?error=login_failed`, { status: 303 });
    }

    const user = data.user;
    const discordId = discordIdFromUser(user);
    if (!discordId) {
        await supabase.auth.signOut();
        return NextResponse.redirect(`${origin}/?error=not_discord`, { status: 303 });
    }

    const service = createServiceClient();
    const identity = (user.identities || []).find((i) => i.provider === 'discord')?.identity_data || {};
    const { error: profileError } = await service.from('zb_profiles').upsert({
        user_id: user.id,
        discord_user_id: discordId,
        username: String(identity.custom_claims?.global_name || identity.full_name || identity.name || '').slice(0, 100),
        avatar_url: identity.avatar_url ? String(identity.avatar_url).slice(0, 500) : null,
        updated_at: new Date().toISOString()
    }, { onConflict: 'user_id' });
    if (profileError) console.error('[auth] profile upsert failed:', profileError.message);

    // The provider token is only available right now; use it once to refresh
    // the server list, never store it. Live checks happen on every action.
    try {
        const guilds = await getUserGuilds(data.session?.provider_token);
        if (Array.isArray(guilds)) {
            const rows = guilds
                .filter((g) => SNOWFLAKE.test(String(g.id)))
                .map((g) => ({
                    user_id: user.id,
                    guild_id: String(g.id),
                    name: String(g.name || '').slice(0, 100),
                    icon: g.icon || null,
                    can_manage: canManageFromOAuthGuild(g),
                    fetched_at: new Date().toISOString()
                }));
            await service.from('zb_user_guilds').delete().eq('user_id', user.id);
            if (rows.length > 0) {
                const { error: guildsError } = await service.from('zb_user_guilds').insert(rows);
                if (guildsError) console.error('[auth] guild list save failed:', guildsError.message);
            }
        }
    } catch (guildError) {
        console.error('[auth] guild list fetch failed:', guildError.message);
    }

    return NextResponse.redirect(`${origin}/dashboard`, { status: 303 });
}
