import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import TopBar from '@/components/TopBar';
import { getCurrentUser } from '@/lib/auth';
import studio from '@/lib/studio/projects';
import specs from '@/lib/studio/specializations';
import projectFiles from '@/lib/studio/files';

export const dynamic = 'force-dynamic';

const TOOLS = {
    code: { label: 'Code', text: 'Edit files, search, history and static checks.' },
    builder: { label: 'Visual builder', text: 'Design workflows on a canvas and test them.' },
    ai: { label: 'AI creator', text: 'Describe a change; review the plan and diffs.' },
    customize: { label: 'Customize', text: 'Presence, messages, colours and the bot token.' },
    deployments: { label: 'Deployments', text: 'Run it on your own machine with a runner.' }
};

// A short getting-started guide per specialization (its own documentation).
const GUIDES = {
    coding: ['Open Code and read src/ (or bot.py): commands live in their own files.', 'Ask the AI creator for a change, for example "add a /ping command", and approve the diff.', 'Run Checks (syntax and lint) before deploying.', 'Add a self-hosted runner in Deployments, then press Deploy.'],
    workflow: ['Open the Visual builder and create a workflow.', 'Start with a trigger (member joins, message sent, schedule), then add conditions and actions.', 'Press Test in simulator to see exactly what the bot would do.', 'Activate it with Premium, or export it as code into the project.'],
    prompt: ['Open the AI creator and describe the bot or feature in plain language.', 'Read the numbered plan and every diff before approving.', 'Refine with follow-up requests: each one is a new proposal you can reject.', 'Deploy the result with a self-hosted runner.']
};

// Project dashboard, shaped by the project's specialization. Only the owner
// gets the page; anyone else gets a 404 (same as a missing project).
export default async function StudioProject({ params }) {
    const { projectId } = await params;
    const current = await getCurrentUser();
    if (!current) redirect('/');
    if (!studio.UUID.test(String(projectId || ''))) notFound();
    const { data } = await current.supabase.from('studio_projects').select('*').eq('id', projectId).eq('owner_id', current.user.id).maybeSingle();
    if (!data || data.owner_id !== current.user.id) notFound();
    const project = studio.projectView(data);
    const spec = specs.byId(project.specialization);
    const framework = studio.frameworkById(project.framework);
    const { data: fileRows } = await current.supabase.from('studio_project_files').select('path, content').eq('project_id', project.id).eq('owner_id', current.user.id).limit(1000);
    const files = projectFiles.fileSummary(fileRows || []);
    return (
        <div className="shell" style={{ '--spec': spec.accent }}>
            <TopBar profile={null} />
            <Link href="/studio" className="small muted" style={{ textDecoration: 'none' }}>← My bots</Link>
            <section className="spec-hero stack" style={{ marginTop: 16 }}>
                <div className="spread">
                    <h1 style={{ margin: 0 }}>{project.name}</h1>
                    <span className="pill">{spec.title}</span>
                </div>
                <p className="help">{project.botName} · {framework?.label} · template {project.template} · {project.visibility} · {project.status}</p>
                {project.description ? <p>{project.description}</p> : null}
                <div className="spec-tools">
                    {spec.tools.map((tool, i) => (
                        <Link key={tool} href={`/studio/${project.id}/${tool}`} className={`spec-tool${i === 0 ? ' is-primary' : ''}`}>
                            <strong>{TOOLS[tool].label}</strong>
                            <span className="help">{TOOLS[tool].text}</span>
                        </Link>
                    ))}
                </div>
            </section>
            <div className="card stack" style={{ marginTop: 16 }}>
                <h2 style={{ margin: 0 }}>Getting started with {spec.title}</h2>
                <ol className="stack">{GUIDES[spec.id].map((step) => <li key={step}>{step}</li>)}</ol>
                {spec.later.length ? <p className="help">Coming later for {spec.title}: {spec.later.join(' · ')}.</p> : null}
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
