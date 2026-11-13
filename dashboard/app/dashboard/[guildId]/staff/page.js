import Link from 'next/link';
import { redirect } from 'next/navigation';
import TopBar from '@/components/TopBar';
import AnalyticsTab from '@/components/AnalyticsTab';
import { getCurrentUser, requireGuildStaff } from '@/lib/auth';

export const dynamic = 'force-dynamic';

// Read-only staff view (Section K): for admins and for members with one of
// the server's dashboard staff roles. Nothing here can change settings.
export default async function StaffPage({ params }) {
    const { guildId } = await params;
    const current = await getCurrentUser();
    if (!current) redirect('/');
    let access = null;
    let failure = null;
    try {
        access = await requireGuildStaff(guildId);
    } catch (error) {
        failure = error.status && error.status < 500 ? error.message : 'Could not load this server right now. Refresh to try again.';
    }
    return (
        <div className="shell">
            <TopBar profile={null} />
            <Link href="/dashboard" className="small muted" style={{ textDecoration: 'none' }}>← All servers</Link>
            {failure ? (
                <div className="card empty" style={{ marginTop: 16 }} role="alert"><h2>No staff access</h2><p className="muted">{failure}</p></div>
            ) : (
                <div className="stack" style={{ marginTop: 16 }}>
                    <div className="card">
                        <h1 style={{ margin: 0 }}>{access.guild.name}: staff view</h1>
                        <p className="help">{access.staff ? 'Read-only: you have a dashboard staff role. Admins change settings.' : 'You are an admin: settings are in the main server page.'}</p>
                        {access.staff ? null : <Link className="btn" href={`/dashboard/${guildId}`}>Open settings</Link>}
                    </div>
                    <AnalyticsTab guildId={guildId} enabled />
                </div>
            )}
        </div>
    );
}
