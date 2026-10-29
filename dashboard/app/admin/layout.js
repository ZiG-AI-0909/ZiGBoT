import { notFound } from 'next/navigation';
import AdminNav from '@/components/admin/AdminNav';
import { getSuperAdmin } from '@/lib/admin';
import './admin.css';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Admin · ZiGBoT', robots: { index: false, follow: false } };

// Private Super Admin area. Anyone who is not a configured Super Admin
// (SUPER_ADMIN_DISCORD_IDS / BOT_CREATOR_ID) gets a plain 404. Each page
// checks again on its own; so does every /api/admin route.
export default async function AdminLayout({ children }) {
    const admin = await getSuperAdmin();
    if (!admin) notFound();
    return (
        <div className="adm">
            <aside className="adm-side">
                <a className="adm-brand" href="/admin">💜 ZiGBoT <small>Super Admin</small></a>
                <AdminNav />
                <div className="help" style={{ fontSize: 12 }}>
                    Signed in as Discord <code>{admin.discordId}</code>
                    <div className="row" style={{ marginTop: 8, gap: 8 }}>
                        <a href="/dashboard" className="btn btn-ghost">Dashboard</a>
                        <form action="/auth/logout" method="post"><button className="btn btn-ghost" type="submit">Log out</button></form>
                    </div>
                </div>
            </aside>
            <div className="adm-main">{children}</div>
        </div>
    );
}
