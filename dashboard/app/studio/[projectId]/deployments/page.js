import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import TopBar from '@/components/TopBar';
import Deployments from '@/components/studio/Deployments';
import { getCurrentUser } from '@/lib/auth';
import studio from '@/lib/studio/projects';

export const dynamic = 'force-dynamic';

export default async function DeploymentsPage({ params }) {
    const { projectId } = await params;
    const current = await getCurrentUser();
    if (!current) redirect('/');
    if (!studio.UUID.test(String(projectId || ''))) notFound();
    const { data } = await current.supabase.from('studio_projects').select('id, owner_id, name').eq('id', projectId).eq('owner_id', current.user.id).maybeSingle();
    if (!data || data.owner_id !== current.user.id) notFound();
    return (
        <div className="shell" style={{ maxWidth: 1000 }}>
            <TopBar profile={null} />
            <Link href={`/studio/${data.id}`} className="small muted" style={{ textDecoration: 'none' }}>← {data.name}</Link>
            <h1>Deployments: {data.name}</h1>
            <Deployments projectId={data.id} />
        </div>
    );
}
