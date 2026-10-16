import Link from 'next/link';

export default function TopBar({ profile }) {
    return (
        <header className="topbar">
            <Link href={profile ? '/dashboard' : '/'} className="brand">
                <span className="brand-mark" aria-hidden="true">Z</span>
                <span>ZiGBoT</span>
            </Link>
            {profile ? (
                <div className="user-chip">
                    {profile.avatar_url ? <img className="avatar" src={profile.avatar_url} alt="" /> : null}
                    <span className="small">{profile.username || 'Signed in'}</span>
                    <form action="/auth/logout" method="post">
                        <button className="btn btn-ghost" type="submit">Log out</button>
                    </form>
                </div>
            ) : null}
        </header>
    );
}
