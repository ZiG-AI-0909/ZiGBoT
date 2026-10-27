import Link from 'next/link';
import { PORTFOLIO_CONTACT_URL } from '@/lib/discord';

export default function TopBar({ profile }) {
    return (
        <header className="topbar">
            <Link href={profile ? '/dashboard' : '/'} className="brand">
                <img className="brand-mark" src="/zigbot.png" alt="" width="30" height="30" />
                <span><span className="zig">ZIG</span>BOT</span>
            </Link>
            <div className="topbar-actions">
                <Link className="btn btn-ghost" href="/commands">📖 Commands</Link>
                <a className="btn btn-ghost" href={PORTFOLIO_CONTACT_URL} target="_blank" rel="noreferrer" title="Contact the creator">💬 Contact</a>
                {profile ? (
                    <div className="user-chip">
                        {profile.avatar_url ? <img className="avatar" src={profile.avatar_url} alt="" /> : null}
                        <span className="small">{profile.username || 'Signed in'}</span>
                        <form action="/auth/logout" method="post">
                            <button className="btn btn-ghost" type="submit">Log out</button>
                        </form>
                    </div>
                ) : null}
            </div>
        </header>
    );
}
