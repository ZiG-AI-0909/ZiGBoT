import Link from 'next/link';
import { redirect } from 'next/navigation';
import TopBar from '@/components/TopBar';
import GuildEditor from '@/components/GuildEditor';
import shared from '@/lib/shared';
import { getCurrentUser, requireGuildAdmin } from '@/lib/auth';
import { loadGuildBundle, prefetchGuildExtras } from '@/lib/guildData';
import { inviteUrl, contactUrl } from '@/lib/discord';
import { identityEnabledFor } from '@/lib/identity';

export const dynamic = 'force-dynamic';

const { FEATURES, LIMITS, TONES, TIERS, PRONOUNS, premiumPerks, FREE_LIMITS, VOICE_SPEAKERS, SUPPORTED_LANGUAGES, DEFAULT_LANGUAGE } = shared;

export default async function GuildPage({ params }) {
    const { guildId } = await params;
    const current = await getCurrentUser();
    if (!current) redirect('/');
    // The top-bar profile is independent of the guild checks: load it alongside them.
    // (.then() starts the lazy Supabase query now instead of when awaited.)
    const profilePromise = current.supabase.from('zb_profiles').select('username, avatar_url').eq('user_id', current.user.id).maybeSingle().then((result) => result);

    let bundle = null;
    let failure = null;
    try {
        // Live Discord verification on every page load — the URL's server id is never trusted.
        const access = await requireGuildAdmin(guildId, { onVerified: prefetchGuildExtras });
        bundle = await loadGuildBundle(access);
    } catch (error) {
        failure = { status: error.status || 500, message: error.publicMessage || error.message, code: error.extra?.code };
        if (failure.status >= 500) {
            console.error('[dashboard] guild page failed:', error?.message);
            failure.message = 'Could not load this server right now. Refresh to try again.';
        }
    }
    const { data: profile } = await profilePromise;

    return (
        <div className="shell">
            <TopBar profile={profile} />
            <Link href="/dashboard" className="small muted" style={{ textDecoration: 'none' }}>← All servers</Link>
            {failure ? (
                <div className="card empty" style={{ marginTop: 16 }} role="alert">
                    <h2>{failure.status === 404 ? 'ZiGBoT is not in this server' : failure.status === 403 ? 'You can’t manage this server' : 'Something went wrong'}</h2>
                    <p className="muted">{failure.message}</p>
                    {failure.code === 'bot_not_installed' ? <a className="btn btn-primary" href={inviteUrl(guildId)} target="_blank" rel="noreferrer">Invite ZiGBoT</a> : null}
                </div>
            ) : (
                <GuildEditor
                    initial={bundle}
                    meta={{ features: FEATURES, limits: LIMITS, tones: TONES, tiers: TIERS, pronouns: PRONOUNS, perks: premiumPerks({ customIdentity: identityEnabledFor(guildId) }), identityEnabled: identityEnabledFor(guildId), languages: SUPPORTED_LANGUAGES, defaultLanguage: DEFAULT_LANGUAGE, freeRoleMappings: FREE_LIMITS.roleMappings, voiceSpeakers: VOICE_SPEAKERS, contactUrl: contactUrl() }}
                />
            )}
        </div>
    );
}
