import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import TopBar from '@/components/TopBar';
import { getCurrentUser } from '@/lib/auth';
import studio from '@/lib/studio/projects';
import projectFiles from '@/lib/studio/files';

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
    const { data: fileRows } = await current.supabase.from('studio_project_files').select('path, content').eq('project_id', project.id).eq('owner_id', current.user.id).limit(1000);
    const files = projectFiles.fileSummary(fileRows || []);
    return (
        <div className="shell">
            <TopBar profile={null} />
            <Link href="/studio" className="small muted" style={{ textDecoration: 'none' }}>← My bots</Link>
            <div className="card stack" style={{ marginTop: 16 }}>
                <h1 style={{ margin: 0 }}>{project.name}</h1>
                <p className="help">{project.botName} · {framework?.label} · template {project.template} · {project.visibility} · {project.status}</p>
                {project.description ? <p>{project.description}</p> : null}
                <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                    <a className="btn btn-primary" href={`/api/studio/projects/${project.id}/export`} download>Download .zip</a>
                    <Link className="btn" href={`/studio/${project.id}/customize`}>Customize</Link>
                    <Link className="btn" href={`/studio/${project.id}/code`}>Open Code Studio</Link>
                    <Link className="btn" href={`/studio/${project.id}/builder`}>Visual builder</Link>
                    <Link className="btn" href={`/studio/${project.id}/ai`}>AI creator</Link>
                </div>
                <p className="help">Start it on your own computer: {framework?.start}. The zip never contains your bot token: copy <code>.env.example</code> to <code>.env</code> and fill it in.</p>
            </div>
            <div className="card" style={{ marginTop: 16 }}>
                <h2 style={{ marginTop: 0 }}>Files ({files.length})</h2>
                {files.length === 0 ? <p className="help">No files yet.</p> : (
                    <ul className="stack" style={{ listStyle: 'none', padding: 0, margin: 0, fontFamily: 'ui-monospace, monospace' }}>
                        {files.map((f) => <li key={f.path}>{f.path} <span className="help">({f.size} bytes)</span></li>)}
                    </ul>
                )}
            </div>
        </div>
    );
}
