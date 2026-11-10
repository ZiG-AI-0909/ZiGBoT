import Link from 'next/link';
import TopBar from '@/components/TopBar';
import { getCurrentUser } from '@/lib/auth';
import { inviteUrl } from '@/lib/discord';
import botList from '@/lib/shared/botList';

// Where Discord sends people after "Add to Discord" (DISCORD_INVITE_WELCOME):
// ?guild_id=… when ZiGBoT was added, ?error=… when they cancelled. Nothing
// here is trusted: the id only builds a link, and /dashboard checks access.
export const dynamic = 'force-dynamic';
export const metadata = { title: 'Welcome · ZiGBoT', robots: { index: false, follow: false } };

export default async function Welcome({ searchParams }) {
    const params = await searchParams;
    const guildId = /^\d{17,20}$/.test(String(params?.guild_id || '')) ? String(params.guild_id) : null;
    let invite = null;
    try {
        invite = inviteUrl();
    } catch {
        invite = null;
    }

    if (params?.error || !guildId) {
        return (
            <div className="shell">
                <TopBar />
                <article className="legal">
                    <h1>No worries</h1>
                    <p>ZiGBoT wasn&apos;t added to a server this time. You can try again whenever you like.</p>
                    <div className="row" style={{ gap: 12 }}>
                        {invite ? <a className="btn btn-primary btn-lg" href={invite}>➕ Add to Discord</a> : null}
                        <Link className="btn btn-lg" href="/">Back to home</Link>
                    </div>
                </article>
            </div>
        );
    }

    // Signed-out visitors sign in first (login lands on /dashboard, where the server is listed).
    let signedIn = false;
    try {
        signedIn = Boolean(await getCurrentUser());
    } catch {
        signedIn = false;
    }

    return (
        <div className="shell">
            <TopBar />
            <article className="legal">
                <h1>ZiGBoT is in! 🎉</h1>
                <p>Thanks for adding ZiGBoT. It has already said hi in your server. Two quick steps and it&apos;s fully set up:</p>
                <ol>
                    <li>
                        <strong>Run <code>/setup</code> in your server.</strong> Pick the language and which roles mean male, female,
                        18+ and under 18, so ZiGBoT roasts the right people and stays gentle with younger members.
                    </li>
                    <li>
                        <strong>Open the dashboard</strong> to choose ZiGBoT&apos;s personality, turn features on or off, and check
                        Anti-Nuke protection.
                    </li>
                </ol>
                <div className="row" style={{ gap: 12 }}>
                    {signedIn
                        ? <Link className="btn btn-primary btn-lg" href={`/dashboard/${guildId}`}>Open this server&apos;s dashboard →</Link>
                        : <a className="btn btn-primary btn-lg" href="/auth/login">Sign in with Discord →</a>}
                    <Link className="btn btn-lg" href="/commands">See commands</Link>
                </div>
                <p>Enjoying ZiGBoT? An upvote helps more servers find it 💜</p>
                <div className="row" style={{ gap: 12 }}>
                    <a className="btn btn-lg" href={botList.VOTE_URL} target="_blank" rel="noreferrer">Upvote on discordbotlist ↗</a>
                </div>
                <p className="muted small">Only the server owner and people with Manage Server can change its settings.</p>
            </article>
        </div>
    );
}
