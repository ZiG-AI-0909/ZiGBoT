import { redirect } from 'next/navigation';
import Link from 'next/link';
import TopBar from '@/components/TopBar';
import StudioWizard from '@/components/studio/StudioWizard';
import { getCurrentUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export default async function StudioNew() {
    const current = await getCurrentUser();
    if (!current) redirect('/');
    return (
        <div className="shell">
            <TopBar profile={null} />
            <Link href="/studio" className="small muted" style={{ textDecoration: 'none' }}>← My bots</Link>
            <div style={{ marginTop: 16 }}><StudioWizard /></div>
        </div>
    );
}
