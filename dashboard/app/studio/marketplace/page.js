import { redirect } from 'next/navigation';
import Link from 'next/link';
import TopBar from '@/components/TopBar';
import Marketplace from '@/components/studio/Marketplace';
import { getCurrentUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export default async function MarketplacePage() {
    const current = await getCurrentUser();
    if (!current) redirect('/');
    const { data } = await current.supabase.from('studio_projects').select('id, name').eq('owner_id', current.user.id).order('name').limit(200);
    return (
        <div className="shell" style={{ maxWidth: 1000 }}>
            <TopBar profile={null} />
            <Link href="/studio" className="small muted" style={{ textDecoration: 'none' }}>← My bots</Link>
            <h1>Marketplace</h1>
            <Marketplace projects={data || []} />
        </div>
    );
}
