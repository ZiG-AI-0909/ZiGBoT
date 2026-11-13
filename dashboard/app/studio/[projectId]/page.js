import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import TopBar from '@/components/TopBar';
import { getCurrentUser } from '@/lib/auth';
import studio from '@/lib/studio/projects';

export const dynamic = 'force-dynamic';

// Project overview. Only the owner gets the page; anyone else gets a 404
// (the same answer as a project that does not exist).
export default async function StudioProject({ params }) {
    const { projectId } = await params;
    const current = await getCurrentUser();
    if (!current) redirect('/');
    if (!studio.UUID.test(String(projectId || ''))) notFound();
    const { data } = await current.supabase.from('studio_projects').select('*').eq('id', projectId).eq('owner_id', current.user.id).maybeSingle();
    if (!data || data.owner_id !== current.user.id) notFound();
    const project = studio.projectView(data);
    const framework = studio.frameworkById(project.framework);
    return (
        <div className="shell">
            <TopBar profile={null} />
            <Link href="/studio" className="small muted" style={{ textDecoration: 'none' }}>← My bots</Link>
            <div className="card stack" style={{ marginTop: 16 }}>
                <h1 style={{ margin: 0 }}>{project.name}</h1>
                <p className="help">{project.botName} · {framework?.label} · template {project.template} · {project.visibility} · {project.status}</p>
                {project.description ? <p>{project.description}</p> : null}
            </div>
        </div>
    );
}
