'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import diff from '@/lib/studio/diff';

// Monaco is served from this site (/monaco/vs, copied at build), never from a CDN.
const Editor = dynamic(async () => {
    const mod = await import('@monaco-editor/react');
    mod.loader.config({ paths: { vs: '/monaco/vs' } });
    return mod.default;
}, { ssr: false, loading: () => <p className="help" aria-busy="true">Loading the editor…</p> });

const LANGUAGE = (path) => (path.endsWith('.ts') ? 'typescript' : path.endsWith('.js') ? 'javascript' : path.endsWith('.py') ? 'python' : path.endsWith('.json') ? 'json' : path.endsWith('.md') ? 'markdown' : 'plaintext');

async function call(url, options = {}) {
    const res = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json' }, cache: 'no-store' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || 'Something went wrong.');
    return body;
}

/**
 * AI assistant pane (right side of the IDE): ask the AI creator for a change
 * to this project. It creates a pending proposal (plan + diffs) that is only
 * written after you approve it on the AI page; nothing changes here.
 */
function AssistantPane({ base, openPath, projectId }) {
    const [text, setText] = useState('');
    const [busy, setBusy] = useState(false);
    const [note, setNote] = useState(null);
    async function ask(e) {
        e.preventDefault();
        setBusy(true); setNote(null);
        try {
            const request = openPath ? `${text}\n(The owner is looking at ${openPath}.)` : text;
            await call(`${base}/ai`, { method: 'POST', body: JSON.stringify({ request }) });
            setText('');
            setNote({ ok: true });
        } catch (err) { setNote({ error: err.message }); } finally { setBusy(false); }
    }
    return (
        <aside className="card ide-assistant stack" aria-label="AI assistant">
            <p className="ide-pane-title">AI assistant <span className={`live-dot ${busy ? 'is-busy' : 'is-ok'}`} aria-hidden="true" /></p>
            <form className="stack" onSubmit={ask}>
                <label className="sr-only" htmlFor="ide-ask">Ask the AI for a change</label>
                <textarea id="ide-ask" rows={5} maxLength={1900} value={text} onChange={(e) => setText(e.target.value)} disabled={busy}
                    placeholder={openPath ? `Change something in ${openPath.split('/').pop()}…` : 'Describe a change…'} />
                <button className="btn btn-primary" type="submit" disabled={busy || !text.trim()} aria-busy={busy}>{busy ? 'Thinking…' : 'Propose change'}</button>
            </form>
            {note?.ok ? <p className="help" role="status">Proposal ready. <a href={`/studio/${projectId}/ai`}>Review the diff and approve →</a></p> : null}
            {note?.error ? <p className="error" role="alert">{note.error}</p> : null}
            <p className="help" style={{ margin: 0 }}>Nothing is written until you approve. For your own Claude or OpenAI agent, open the <a href={`/studio/${projectId}/ai`}>AI page</a>.</p>
        </aside>
    );
}

export default function CodeStudio({ projectId }) {
    const base = `/api/studio/projects/${projectId}`;
    const [files, setFiles] = useState([]);
    const [open, setOpen] = useState(null); // { path, content, saved }
    const [message, setMessage] = useState(null);
    const [panel, setPanel] = useState('checks');
    const [query, setQuery] = useState('');
    const [hits, setHits] = useState([]);
    const [versions, setVersions] = useState([]);
    const [compare, setCompare] = useState(null);
    const [vars, setVars] = useState([]);
    const [newVar, setNewVar] = useState({ name: '', value: '' });
    const [checkInfo, setCheckInfo] = useState({ checks: [], notAvailable: [] });
    const [checkResult, setCheckResult] = useState(null);
    const [busyCheck, setBusyCheck] = useState(false);

    const say = (ok, error) => setMessage(error ? { error } : { ok });
    const loadFiles = useCallback(() => call(`${base}/files`).then((b) => setFiles(b.files)).catch((e) => say(null, e.message)), [base]);
    useEffect(() => {
        loadFiles();
        call(`${base}/checks`).then(setCheckInfo).catch(() => {});
        call(`${base}/env`).then((b) => setVars(b.variables)).catch(() => {});
    }, [base, loadFiles]);

    async function openFile(path) {
        if (open && open.content !== open.saved && !window.confirm('Discard unsaved changes?')) return;
        try {
            const b = await call(`${base}/file?path=${encodeURIComponent(path)}`);
            setOpen({ path: b.path, content: b.content, saved: b.content });
            setCompare(null);
            call(`${base}/versions?path=${encodeURIComponent(path)}`).then((v) => setVersions(v.versions)).catch(() => setVersions([]));
        } catch (e) { say(null, e.message); }
    }
    async function save() {
        try {
            await call(`${base}/file`, { method: 'PUT', body: JSON.stringify({ path: open.path, content: open.content }) });
            setOpen({ ...open, saved: open.content });
            say(`Saved ${open.path}.`);
            setVersions((await call(`${base}/versions?path=${encodeURIComponent(open.path)}`)).versions);
            loadFiles();
        } catch (e) { say(null, e.message); }
    }
    async function create() {
        const path = window.prompt('New file path (for example src/commands/hello.js)');
        if (!path) return;
        try { await call(`${base}/file`, { method: 'POST', body: JSON.stringify({ path, content: '' }) }); await loadFiles(); openFile(path); say(`Created ${path}.`); } catch (e) { say(null, e.message); }
    }
    async function rename(path) {
        const to = window.prompt('Rename to', path);
        if (!to || to === path) return;
        try { await call(`${base}/file`, { method: 'PATCH', body: JSON.stringify({ from: path, to }) }); if (open?.path === path) setOpen({ ...open, path: to }); await loadFiles(); say(`Renamed to ${to}.`); } catch (e) { say(null, e.message); }
    }
    async function remove(path) {
        if (!window.confirm(`Delete ${path}? This cannot be undone.`)) return;
        try { await call(`${base}/file`, { method: 'DELETE', body: JSON.stringify({ path }) }); if (open?.path === path) setOpen(null); await loadFiles(); say(`Deleted ${path}.`); } catch (e) { say(null, e.message); }
    }
    async function search(e) {
        e.preventDefault();
        try { setHits((await call(`${base}/search?q=${encodeURIComponent(query)}`)).hits); setPanel('search'); } catch (err) { say(null, err.message); }
    }
    async function showVersion(id) {
        try {
            const { version } = await call(`${base}/versions?path=${encodeURIComponent(open.path)}&id=${id}`);
            setCompare({ id, createdAt: version.createdAt, lines: diff.diffLines(version.content, open.content), content: version.content });
            setPanel('history');
        } catch (e) { say(null, e.message); }
    }
    async function runCheck(id) {
        setBusyCheck(true);
        try { setCheckResult((await call(`${base}/checks`, { method: 'POST', body: JSON.stringify({ check: id }) })).result); setPanel('checks'); } catch (e) { say(null, e.message); } finally { setBusyCheck(false); }
    }
    async function saveVar(e) {
        e.preventDefault();
        try { await call(`${base}/env`, { method: 'PUT', body: JSON.stringify(newVar) }); setNewVar({ name: '', value: '' }); setVars((await call(`${base}/env`)).variables); say('Variable saved (encrypted).'); } catch (err) { say(null, err.message); }
    }
    async function deleteVar(name) {
        try { await call(`${base}/env`, { method: 'DELETE', body: JSON.stringify({ name }) }); setVars((await call(`${base}/env`)).variables); } catch (e) { say(null, e.message); }
    }

    const dirty = open && open.content !== open.saved;
    const tree = useMemo(() => files.map((f) => ({ ...f, depth: f.path.split('/').length - 1, name: f.path.split('/').pop(), folder: f.path.split('/').slice(0, -1).join('/') })), [files]);

    return (
        <div className="stack">
            {message?.error ? <p className="error" role="alert">{message.error}</p> : null}
            {message?.ok ? <p className="help" role="status">{message.ok}</p> : null}
            <div className="ide-status" role="status" aria-label="Workspace status">
                <span><span className={`live-dot ${busyCheck ? 'is-busy' : dirty ? 'is-warn' : 'is-ok'}`} /> {busyCheck ? 'Checking…' : dirty ? 'Unsaved changes' : 'All changes saved'}</span>
                <span>{files.length} files</span>
                {open ? <span>{open.path} · {LANGUAGE(open.path)}</span> : null}
                {checkResult ? <span>{checkResult.label}: {checkResult.ok ? 'ok ✓' : `${checkResult.problems.length} problem(s)`}</span> : null}
            </div>
            <div className="ide">
                <nav className="card ide-explorer" aria-label="Files" style={{ overflow: 'auto', maxHeight: '75vh' }}>
                    <p className="ide-pane-title">Explorer</p>
                    <form onSubmit={search} className="row" style={{ gap: 6 }}>
                        <label className="sr-only" htmlFor="cs-search">Search files</label>
                        <input id="cs-search" type="search" placeholder="Search" value={query} onChange={(e) => setQuery(e.target.value)} style={{ minWidth: 0, flex: 1 }} />
                    </form>
                    <button className="btn" type="button" onClick={create} style={{ margin: '8px 0' }}>New file</button>
                    <ul style={{ listStyle: 'none', padding: 0, margin: 0, fontFamily: 'ui-monospace, monospace', fontSize: 13 }}>
                        {tree.map((f, i) => (
                            <li key={f.path}>
                                {f.folder && f.folder !== tree[i - 1]?.folder ? <div className="help" style={{ paddingLeft: (f.depth - 1) * 10 }}>{f.folder}/</div> : null}
                                <div className="row" style={{ gap: 4, paddingLeft: f.depth * 10, alignItems: 'center' }}>
                                    <button type="button" className="link" onClick={() => openFile(f.path)} aria-current={open?.path === f.path ? 'true' : undefined} style={{ flex: 1, textAlign: 'left', fontWeight: open?.path === f.path ? 700 : 400 }}>{f.name}</button>
                                    <button type="button" className="link" aria-label={`Rename ${f.path}`} onClick={() => rename(f.path)}>✎</button>
                                    <button type="button" className="link" aria-label={`Delete ${f.path}`} onClick={() => remove(f.path)}>✕</button>
                                </div>
                            </li>
                        ))}
                    </ul>
                </nav>
                <AssistantPane base={base} openPath={open?.path} projectId={projectId} />
                <div className="ide-editor-wrap" style={{ display: 'contents' }}>
                    <div className="card ide-editor" style={{ padding: 8 }}>
                        <div className="row" style={{ justifyContent: 'space-between', gap: 8, marginBottom: 8 }}>
                            <strong>{open ? `${open.path}${dirty ? ' •' : ''}` : 'Pick a file'}</strong>
                            {open ? <button className="btn btn-primary" type="button" onClick={save} disabled={!dirty}>Save</button> : null}
                        </div>
                        {open ? (
                            <Editor height="55vh" theme="vs-dark" path={open.path} language={LANGUAGE(open.path)} value={open.content}
                                onChange={(value) => setOpen((o) => ({ ...o, content: value ?? '' }))} options={{ minimap: { enabled: false }, fontSize: 14, tabSize: 4 }} />
                        ) : <p className="help">Choose a file on the left.</p>}
                    </div>
                    <div className="card ide-console">
                        <p className="ide-pane-title">Output &amp; tools</p>
                        <div className="tabs" role="tablist" aria-label="Panels">
                            {[['checks', 'Checks'], ['history', 'History'], ['search', 'Search'], ['env', 'Environment']].map(([id, label]) => (
                                <button key={id} type="button" role="tab" className="tab" aria-selected={panel === id} onClick={() => setPanel(id)}>{label}</button>
                            ))}
                        </div>
                        {panel === 'checks' ? (
                            <div className="stack" style={{ marginTop: 8 }}>
                                <p className="help">Static checks only: your code is parsed, never run. There is no terminal.</p>
                                <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>{checkInfo.checks.map((c) => <button key={c.id} className="btn" type="button" onClick={() => runCheck(c.id)}>{c.label}</button>)}</div>
                                {checkInfo.notAvailable.map((c) => <p key={c.id} className="help"><strong>{c.label}: not available.</strong> {c.reason}</p>)}
                                {checkResult ? (
                                    <div aria-live="polite">
                                        <strong>{checkResult.label}: {checkResult.ok ? 'no problems ✓' : `${checkResult.problems.length} problem(s)`}</strong>
                                        <ul>{checkResult.problems.map((p, i) => <li key={i}><button type="button" className="link" onClick={() => openFile(p.path)}>{p.path}{p.line ? `:${p.line}` : ''}</button> {p.message}</li>)}</ul>
                                    </div>
                                ) : null}
                            </div>
                        ) : null}
                        {panel === 'history' ? (
                            <div className="stack" style={{ marginTop: 8 }}>
                                {!open ? <p className="help">Open a file to see its history.</p> : versions.length === 0 ? <p className="help">No saved versions yet. Every save keeps a snapshot (50 per project).</p> : (
                                    <ul>{versions.map((v) => <li key={v.id}><button type="button" className="link" onClick={() => showVersion(v.id)}>{new Date(v.createdAt).toLocaleString()}</button> ({v.size} bytes)</li>)}</ul>
                                )}
                                {compare ? (
                                    <div>
                                        <div className="row" style={{ gap: 8 }}>
                                            <strong>Changes since {new Date(compare.createdAt).toLocaleString()}</strong>
                                            <button className="btn" type="button" onClick={() => setOpen({ ...open, content: compare.content })}>Restore this version</button>
                                        </div>
                                        <pre style={{ maxHeight: 300, overflow: 'auto', fontSize: 12 }}>{compare.lines.map((l, i) => <div key={i} style={{ background: l.type === 'add' ? 'rgba(34,197,94,.18)' : l.type === 'del' ? 'rgba(239,68,68,.18)' : 'transparent' }}>{l.type === 'add' ? '+ ' : l.type === 'del' ? '- ' : '  '}{l.text}</div>)}</pre>
                                    </div>
                                ) : null}
                            </div>
                        ) : null}
                        {panel === 'search' ? (
                            <ul style={{ marginTop: 8 }}>{hits.length === 0 ? <li className="help">No results.</li> : hits.map((h, i) => <li key={i}><button type="button" className="link" onClick={() => openFile(h.path)}>{h.path}{h.line ? `:${h.line}` : ''}</button> <code>{h.text}</code></li>)}</ul>
                        ) : null}
                        {panel === 'env' ? (
                            <div className="stack" style={{ marginTop: 8 }}>
                                <p className="help">Encrypted on the server. Values are never shown again and never exported. The bot token is set on the Customize page.</p>
                                <ul>{vars.map((v) => <li key={v.name}><code>{v.name}</code> configured ✓ …{v.last4} <button type="button" className="link" onClick={() => deleteVar(v.name)}>remove</button></li>)}</ul>
                                <form className="row" style={{ gap: 8, flexWrap: 'wrap' }} onSubmit={saveVar}>
                                    <label className="sr-only" htmlFor="cs-var-name">Name</label>
                                    <input id="cs-var-name" placeholder="NAME" value={newVar.name} onChange={(e) => setNewVar({ ...newVar, name: e.target.value.toUpperCase() })} />
                                    <label className="sr-only" htmlFor="cs-var-value">Value</label>
                                    <input id="cs-var-value" type="password" autoComplete="off" placeholder="value" value={newVar.value} onChange={(e) => setNewVar({ ...newVar, value: e.target.value })} />
                                    <button className="btn" type="submit" disabled={!newVar.name || !newVar.value}>Save variable</button>
                                </form>
                            </div>
                        ) : null}
                    </div>
                </div>
            </div>
        </div>
    );
}
