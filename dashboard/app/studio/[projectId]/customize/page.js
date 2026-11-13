import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import TopBar from '@/components/TopBar';
import StudioCustomize from '@/components/studio/StudioCustomize';
import { getCurrentUser } from '@/lib/auth';
import studio from '@/lib/studio/projects';
import generators from '@/lib/studio/generators';

export const dynamic = 'force-dynamic';

export default async function CustomizePage({ params }) {
    const { projectId } = await params;
    const current = await getCurrentUser();
    if (!current) redirect('/');
    if (!studio.UUID.test(String(projectId || ''))) notFound();
    const { data } = await current.supabase.from('studio_projects').select('id, owner_id, name, bot_name, template').eq('id', projectId).eq('owner_id', current.user.id).maybeSingle();
    if (!data || data.owner_id !== current.user.id) notFound();
    return (
        <div className="shell">
            <TopBar profile={null} />
            <Link href={`/studio/${data.id}`} className="small muted" style={{ textDecoration: 'none' }}>← {data.name}</Link>
            <h1>Customize {data.bot_name}</h1>
            <StudioCustomize projectId={data.id} botName={data.bot_name} commands={generators.TEMPLATE_PARTS[data.template]?.commands || []} />
        </div>
    );
}
