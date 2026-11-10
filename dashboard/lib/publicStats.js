import 'server-only';
import { unstable_cache } from 'next/cache';
import { createServiceClient } from './supabase/server';

/**
 * Servers ZiGBoT is in right now (zb_guilds: installed and not removed), for
 * the home page. Cached for 10 minutes so visitors never hit the database
 * directly. Null when it cannot be read: the page then shows nothing rather
 * than a made-up number.
 */
export const publicServerCount = unstable_cache(async () => {
    try {
        const { count, error } = await createServiceClient()
            .from('zb_guilds')
            .select('guild_id', { count: 'exact', head: true })
            .eq('bot_installed', true)
            .is('removed_at', null);
        if (error) {
            console.error('[stats] server count failed:', error.message);
            return null;
        }
        return count ?? null;
    } catch {
        return null;
    }
}, ['public-server-count'], { revalidate: 600 });
