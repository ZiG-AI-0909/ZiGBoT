import Link from 'next/link';
import { redirect } from 'next/navigation';
import TopBar from '@/components/TopBar';
import { getCurrentUser } from '@/lib/auth';
import { createServiceClient } from '@/lib/supabase/server';
import { guildIconUrl, inviteUrl } from '@/lib/discord';
import { loadBotStatus } from '@/lib/guildData';

export const dynamic = 'force-dynamic';

function initials(name) {
    return String(name || '?').split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
}

export default async function DashboardHome() {
    const current = await getCurrentUser();
    if (!current) redirect('/');

    let guilds = [];
    let installed = new Map();
    let botStatus = { online: false, lastSeen: null };
    let profile = null;
    let loadError = null;
    try {
        const [{ data: rows, error }, { data: prof }] = await Promise.all([
            // RLS: only this user's own rows.
            current.supabase.from('zb_user_guilds').select('guild_id, name, icon, fetched_at').eq('can_manage', true).order('name'),
            current.supabase.from('zb_profiles').select('username, avatar_url').eq('user_id', current.user.id).maybeSingle()
        ]);
        if (error) throw error;
        guilds = rows || [];
        profile = prof || { username: current.user.user_metadata?.full_name || '' };
        if (guilds.length > 0) {
            // Bot-presence flags for the user's OWN server ids only.
            const { data: flags } = await createServiceClient().from('zb_guilds').select('guild_id, bot_installed').in('guild_id', guilds.map((g) => g.guild_id));
            installed = new Map((flags || []).map((f) => [f.guild_id, f.bot_installed]));
        }
        botStatus = await loadBotStatus();
    } catch (error) {
        console.error('[dashboard] server list failed:', error?.message);
        loadError = error?.publicMessage || 'Could not load your servers right now. Refresh to try again.';
    }

    const withBot = guilds.filter((g) => installed.get(g.guild_id));
    const withoutBot = guilds.filter((g) => !installed.get(g.guild_id));

    return (
        <div className="shell">
            <TopBar profile={profile} />
            <div className="spread" style={{ marginBottom: 20 }}>
                <div>
                    <h1>Your servers</h1>
                    <p className="muted small">Servers where you have Manage Server or Administrator. The list refreshes each time you sign in.</p>
                </div>
                <span className={`pill ${botStatus.online ? 'pill-ok' : 'pill-bad'}`} title={botStatus.lastSeen ? `Last heartbeat ${new Date(botStatus.lastSeen).toUTCString()}` : 'No heartbeat yet'}>
                    Bot {botStatus.online ? 'online' : 'offline'}
                </span>
            </div>

            {loadError ? <div className="notice" role="alert">{loadError}</div> : null}

            {!loadError && guilds.length === 0 ? (
                <div className="card empty">
                    <h2>No servers to manage yet</h2>
                    <p className="muted">You need Manage Server or Administrator in a Discord server. If you just got it, log out and sign in again to refresh the list.</p>
                </div>
            ) : null}

            {withBot.length > 0 ? (
                <section className="stack" style={{ marginBottom: 28 }}>
                    <h2>ZiGBoT installed</h2>
                    <div className="guild-grid">
                        {withBot.map((g) => (
                            <Link key={g.guild_id} href={`/dashboard/${g.guild_id}`} className="card guild-card" style={{ textDecoration: 'none' }}>
                                {g.icon ? <img className="guild-icon" src={guildIconUrl(g.guild_id, g.icon)} alt="" /> : <span className="guild-icon">{initials(g.name)}</span>}
                                <span className="meta">
                                    <span className="name" style={{ display: 'block' }}>{g.name}</span>
                                    <span className="pill pill-ok">Installed</span>
                                </span>
                                <span className="muted" aria-hidden="true">→</span>
                            </Link>
                        ))}
                    </div>
                </section>
            ) : null}

            {withoutBot.length > 0 ? (
                <section className="stack">
                    <h2>Add ZiGBoT</h2>
                    <div className="guild-grid">
                        {withoutBot.map((g) => (
                            <div key={g.guild_id} className="card guild-card">
                                {g.icon ? <img className="guild-icon" src={guildIconUrl(g.guild_id, g.icon)} alt="" /> : <span className="guild-icon">{initials(g.name)}</span>}
                                <span className="meta">
                                    <span className="name" style={{ display: 'block' }}>{g.name}</span>
                                    <span className="pill">Not installed</span>
                                </span>
                                <a className="btn" href={safeInvite(g.guild_id)} target="_blank" rel="noreferrer">Invite</a>
                            </div>
                        ))}
                    </div>
                    <p className="help">After inviting, refresh this page. New servers start with safe defaults: friendly tone, replies only when mentioned, memory off.</p>
                </section>
            ) : null}
        </div>
    );
}

function safeInvite(guildId) {
    try {
        return inviteUrl(guildId);
    } catch {
        return '#';
    }
}
