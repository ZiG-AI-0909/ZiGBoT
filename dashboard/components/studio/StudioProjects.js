'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

// ZiGBoT Studio "My bots": list, rename, duplicate, archive and delete (typed
// confirmation). Every action goes to /api/studio/projects, which checks the
// owner server-side; this page only reflects the answers.
async function call(url, options = {}) {
    const res = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, cache: 'no-store' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
        const error = new Error(body.error || 'Something went wrong.');
        error.fields = body.fieldErrors;
        throw error;
    }
    return body;
}

const LANG = { javascript: 'JavaScript', typescript: 'TypeScript', python: 'Python' };

export default function StudioProjects() {
    const [state, setState] = useState({ loading: true, projects: [], plan: 'free', limit: 3 });
    const [message, setMessage] = useState(null);
    const [busy, setBusy] = useState(null);
    const [renaming, setRenaming] = useState(null);
    const [deleting, setDeleting] = useState(null);
    const [filter, setFilter] = useState('active');
    const [search, setSearch] = useState('');

    async function load() {
        try {
            const body = await call('/api/studio/projects');
            setState({ loading: false, projects: body.projects, plan: body.plan, limit: body.limit });
        } catch (error) {
            setState((s) => ({ ...s, loading: false }));
            setMessage({ error: error.message });
        }
    }
    useEffect(() => { load(); }, []);

    async function act(id, fn, done) {
        setBusy(id);
        setMessage(null);
        try {
            await fn();
            setMessage({ ok: done });
            await load();
        } catch (error) {
            setMessage({ error: error.message });
        } finally {
            setBusy(null);
        }
    }

    const shown = state.projects
        .filter((p) => p.status === filter)
        .filter((p) => !search.trim() || `${p.name} ${p.botName} ${p.description}`.toLowerCase().includes(search.trim().toLowerCase()));
    const atLimit = state.projects.length >= state.limit;

    return (
        <div className="stack">
            <div className="card">
                <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
                    <div>
                        <h1 style={{ margin: 0 }}>My bots</h1>
                        <p className="help">{state.projects.length} of {state.limit} projects on the {state.plan} plan.</p>
                    </div>
                    {atLimit
                        ? <span className="help" role="status">Project limit reached: delete one to create another.</span>
                        : <Link className="btn btn-primary" href="/studio/new">Create new bot</Link>}
                </div>
                <div className="row" style={{ gap: 12, flexWrap: 'wrap', marginTop: 12 }}>
                    <label className="field" htmlFor="studio-search" style={{ flex: 1, minWidth: 200 }}>
                        <span className="label">Search</span>
                        <input id="studio-search" type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Name or description" />
                    </label>
                    <label className="field" htmlFor="studio-filter">
                        <span className="label">Show</span>
                        <select id="studio-filter" value={filter} onChange={(e) => setFilter(e.target.value)}>
                            <option value="active">Active</option>
                            <option value="archived">Archived</option>
                        </select>
                    </label>
                </div>
                {message?.error ? <p className="error" role="alert">{message.error}</p> : null}
                {message?.ok ? <p className="help" role="status">{message.ok}</p> : null}
            </div>

            {state.loading ? <div className="card" aria-busy="true"><p className="help">Loading your projects…</p></div> : null}
            {!state.loading && shown.length === 0 ? (
                <div className="card empty">
                    <h2>{filter === 'archived' ? 'No archived projects' : 'No bots yet'}</h2>
                    {filter === 'active' && !atLimit ? <Link className="btn btn-primary" href="/studio/new">Create your first bot</Link> : null}
                </div>
            ) : null}

            {shown.map((p) => (
                <div className="card" key={p.id}>
                    <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
                        <div>
                            <h2 style={{ margin: 0 }}><Link href={`/studio/${p.id}`}>{p.name}</Link></h2>
                            <p className="help">{p.botName} · {LANG[p.language]} · {p.template} · {p.visibility}</p>
                            {p.description ? <p>{p.description}</p> : null}
                        </div>
                        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                            <button type="button" className="btn" disabled={busy === p.id} onClick={() => setRenaming({ id: p.id, name: p.name })}>Rename</button>
                            <button type="button" className="btn" disabled={busy === p.id || atLimit} onClick={() => act(p.id, () => call(`/api/studio/projects/${p.id}/duplicate`, { method: 'POST' }), 'Project duplicated.')}>Duplicate</button>
                            <button type="button" className="btn" disabled={busy === p.id} onClick={() => act(p.id, () => call(`/api/studio/projects/${p.id}`, { method: 'PATCH', body: JSON.stringify({ status: p.status === 'active' ? 'archived' : 'active' }) }), p.status === 'active' ? 'Project archived.' : 'Project restored.')}>{p.status === 'active' ? 'Archive' : 'Unarchive'}</button>
                            <button type="button" className="btn btn-danger" disabled={busy === p.id} onClick={() => setDeleting({ id: p.id, name: p.name, typed: '' })}>Delete</button>
                        </div>
                    </div>
                    {renaming?.id === p.id ? (
                        <form className="row" style={{ gap: 8, marginTop: 12, flexWrap: 'wrap' }} onSubmit={(e) => { e.preventDefault(); act(p.id, () => call(`/api/studio/projects/${p.id}`, { method: 'PATCH', body: JSON.stringify({ name: renaming.name }) }), 'Project renamed.').then(() => setRenaming(null)); }}>
                            <label className="sr-only" htmlFor={`rename-${p.id}`}>New name</label>
                            <input id={`rename-${p.id}`} value={renaming.name} maxLength={40} onChange={(e) => setRenaming({ ...renaming, name: e.target.value })} />
                            <button className="btn btn-primary" type="submit">Save name</button>
                            <button className="btn" type="button" onClick={() => setRenaming(null)}>Cancel</button>
                        </form>
                    ) : null}
                    {deleting?.id === p.id ? (
                        <div role="alertdialog" aria-labelledby={`del-${p.id}`} className="stack" style={{ marginTop: 12, border: '1px solid var(--border)', borderRadius: 12, padding: 12 }}>
                            <strong id={`del-${p.id}`}>Delete “{p.name}” for good?</strong>
                            <span className="help">This cannot be undone. Type the project name to confirm.</span>
                            <input aria-label="Project name" value={deleting.typed} onChange={(e) => setDeleting({ ...deleting, typed: e.target.value })} />
                            <div className="row" style={{ gap: 8 }}>
                                <button className="btn btn-danger" type="button" disabled={deleting.typed !== p.name} onClick={() => act(p.id, () => call(`/api/studio/projects/${p.id}`, { method: 'DELETE', body: JSON.stringify({ confirmName: deleting.typed }) }), 'Project deleted.').then(() => setDeleting(null))}>Delete project</button>
                                <button className="btn" type="button" onClick={() => setDeleting(null)}>Cancel</button>
                            </div>
                        </div>
                    ) : null}
                </div>
            ))}
        </div>
    );
}
