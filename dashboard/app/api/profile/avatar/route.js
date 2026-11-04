import { handler, json } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import { getDiscordUser } from '@/lib/discord';
import { createServiceClient } from '@/lib/supabase/server';
import shared from '@/lib/shared';

export const dynamic = 'force-dynamic';

// POST: refresh the SIGNED-IN user's picture from Discord (UserAvatar calls it
// when the stored one fails). The id comes from the verified session.
export const POST = handler(async () => {
    const { user, discordId } = await requireUser();
    const discordUser = await getDiscordUser(discordId);
    if (!discordUser) return json({ url: null });
    const url = shared.discordAvatarUrl(discordId, discordUser.avatar);
    const { error } = await createServiceClient().from('zb_profiles')
        .update({ avatar_url: url, updated_at: new Date().toISOString() })
        .eq('user_id', user.id);
    if (error) console.error('[auth] avatar refresh failed:', error.message);
    return json({ url });
});
