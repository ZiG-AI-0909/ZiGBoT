import { notFound } from 'next/navigation';
import TopBar from '@/components/TopBar';
import IdentityReview from '@/components/IdentityReview';
import { getCurrentUser } from '@/lib/auth';
import { createServiceClient } from '@/lib/supabase/server';
import { isBotOwner } from '@/lib/identity';
import { env } from '@/lib/env';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Identity review · ZiGBoT', robots: { index: false, follow: false } };

// Bot owner only (BOT_CREATOR_ID): avatars waiting for review, and blocks.
// Everyone else sees a 404.
export default async function IdentityReviewPage() {
    const current = await getCurrentUser().catch(() => null);
    if (!current || !isBotOwner(current.discordId)) notFound();

    const db = createServiceClient();
    const [{ data: pending, error }, { data: blocks }, { data: profile }] = await Promise.all([
        db.from('zb_guild_identity')
            .select('guild_id, nick, bio, avatar_path, pending_submitted_at, pending_submitted_by')
            .not('pending_avatar_path', 'is', null)
            .order('pending_submitted_at', { ascending: true })
            .limit(50),
        db.from('zb_identity_blocks').select('id, kind, target_id, reason, context_guild_id, created_at').order('created_at', { ascending: false }).limit(100),
        current.supabase.from('zb_profiles').select('username, avatar_url').eq('user_id', current.user.id).maybeSingle()
    ]);
    const ids = [...new Set((pending || []).map((p) => p.guild_id))];
    const { data: guilds } = ids.length ? await db.from('zb_guilds').select('guild_id, name').in('guild_id', ids) : { data: [] };
    const names = new Map((guilds || []).map((g) => [g.guild_id, g.name]));

    return (
        <div className="shell">
            <TopBar profile={profile} />
            <h1>Identity review</h1>
            {!env.customIdentityEnabled ? <div className="notice">Custom bot identity is switched off (CUSTOM_IDENTITY_ENABLED). Approvals are saved and applied once it is on.</div> : null}
            {error ? <div className="notice" role="alert">Could not load the review queue. Has the custom identity migration been applied?</div> : null}
            <IdentityReview
                pending={(pending || []).map((p) => ({ ...p, guild_name: names.get(p.guild_id) || p.guild_id }))}
                blocks={blocks || []}
            />
        </div>
    );
}
