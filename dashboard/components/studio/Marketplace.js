'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';

async function call(url, options = {}) {
    const res = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json' }, cache: 'no-store' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(body.error || 'Something went wrong.'), { body });
    return body;
}

const FRAMEWORK = { discordjs: 'discord.js', 'discordjs-ts': 'discord.js (TS)', discordpy: 'discord.py' };
const STATUS = { pending_review: 'Pending review', published: 'Published', rejected: 'Rejected', unpublished: 'Unpublished' };

export default function Marketplace({ projects }) {
    const [state, setState] = useState(null);
    const [message, setMessage] = useState(null);
    const [query, setQuery] = useState('');
    const [form, setForm] = useState({ projectId: projects[0]?.id || '', name: '', description: '' });

    const load = useCallback(() => call('/api/studio/marketplace').then(setState).catch((e) => setMessage({ error: e.message })), []);
    useEffect(() => { load(); }, [load]);

    async function act(id, action, extra = {}) {
        try {
            const r = await call(`/api/studio/marketplace/${id}`, { method: 'POST', body: JSON.stringify({ action, ...extra }) });
            setMessage({ ok: action === 'install' ? `Installed as “${r.project.name}”. Nothing was run; the files were copied into your new project.` : `Template ${STATUS[r.status].toLowerCase()}.` });
            load();
        } catch (e) { setMessage({ error: e.message }); }
    }
    async function publish(e) {
        e.preventDefault();
        try {
            await call('/api/studio/marketplace', { method: 'POST', body: JSON.stringify(form) });
            setMessage({ ok: 'Sent for review. The static scan results are under “My templates”.' });
            setForm({ ...form, name: '', description: '' });
            load();
        } catch (err) {
            const findings = err.body?.findings || [];
            setMessage({ error: `${err.message}${findings.length ? ` (${findings.map((f) => `${f.path}:${f.line} ${f.rule}`).join(', ')})` : ''}` });
        }
    }

    if (!state && !message) return <p className="help" aria-busy="true">Loading…</p>;
    const q = query.trim().toLowerCase();
    const published = (state?.published || []).filter((t) => !q || `${t.name} ${t.description}`.toLowerCase().includes(q));
    return (
        <div className="stack">
            {message?.error ? <p className="error" role="alert">{message.error}</p> : null}
            {message?.ok ? <p className="help" role="status">{message.ok}</p> : null}
            {state ? (
                <div className="card">
                    <strong>Your plan: {state.plan}</strong>
                    <p className="help">Up to {state.limits.projects} projects, {state.limits.aiPerDay} AI requests a day, {state.limits.templates} published template(s), {state.limits.simulatorRunsPerDay} simulator runs a day.</p>
                    <p className="help"><strong>Billing: not available.</strong> {state.billing.reason}</p>
                </div>
            ) : null}
            <section className="card stack">
                <h2 style={{ margin: 0 }}>Templates</h2>
                <label className="sr-only" htmlFor="mk-search">Search templates</label>
                <input id="mk-search" type="search" placeholder="Search templates" value={query} onChange={(e) => setQuery(e.target.value)} />
                {published.length === 0 ? <p className="help">No published templates yet.</p> : published.map((t) => (
                    <div key={t.id} className="row" style={{ justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                        <div><strong>{t.name}</strong> <span className="help">{FRAMEWORK[t.framework]} · {t.files} files · {t.installs} installs</span><div className="help">{t.description}</div></div>
                        <button className="btn" type="button" onClick={() => act(t.id, 'install')}>Install (copy)</button>
                    </div>
                ))}
            </section>
            <form className="card stack" onSubmit={publish}>
                <h2 style={{ margin: 0 }}>Publish a project as a template</h2>
                {projects.length === 0 ? <p className="help">Create a project first. <Link href="/studio">My bots</Link></p> : (
                    <>
                        <div className="field"><label htmlFor="mk-project">Project</label><select id="mk-project" value={form.projectId} onChange={(e) => setForm({ ...form, projectId: e.target.value })}>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></div>
                        <div className="field"><label htmlFor="mk-name">Template name</label><input id="mk-name" maxLength={60} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
                        <div className="field"><label htmlFor="mk-desc">Description</label><textarea id="mk-desc" rows={3} maxLength={500} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></div>
                        <p className="help">Secrets (.env, keys) are never included. A static scan checks for tokens, eval, child_process and obfuscated code; templates with a credential are refused, the rest wait for review.</p>
                        <button className="btn btn-primary" type="submit" disabled={form.name.trim().length < 3}>Publish for review</button>
                    </>
                )}
            </form>
            <section className="card stack">
                <h2 style={{ margin: 0 }}>My templates</h2>
                {(state?.mine || []).length === 0 ? <p className="help">None yet.</p> : state.mine.map((t) => (
                    <div key={t.id} className="row" style={{ justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                        <div><strong>{t.name}</strong> <span className="help">{STATUS[t.status]} · {(t.scan?.findings || []).length} scan finding(s)</span>
                            {(t.scan?.findings || []).length ? <ul className="help">{t.scan.findings.slice(0, 10).map((f, i) => <li key={i}>{f.path}:{f.line} {f.rule}</li>)}</ul> : null}
                        </div>
                        {['published', 'pending_review'].includes(t.status) ? <button className="btn" type="button" onClick={() => act(t.id, 'unpublish')}>Unpublish</button> : null}
                    </div>
                ))}
            </section>
            {(state?.review || []).length ? (
                <section className="card stack">
                    <h2 style={{ margin: 0 }}>Review queue (Super Admin)</h2>
                    {state.review.map((t) => (
                        <div key={t.id} className="row" style={{ justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                            <div><strong>{t.name}</strong> <span className="help">{(t.scan?.findings || []).length} finding(s): {(t.scan?.findings || []).slice(0, 5).map((f) => f.rule).join(', ') || 'none'}</span></div>
                            <span className="row" style={{ gap: 6 }}>
                                <button className="btn btn-primary" type="button" onClick={() => act(t.id, 'approve')}>Approve</button>
                                <button className="btn" type="button" onClick={() => act(t.id, 'reject')}>Reject</button>
                            </span>
                        </div>
                    ))}
                </section>
            ) : null}
        </div>
    );
}
