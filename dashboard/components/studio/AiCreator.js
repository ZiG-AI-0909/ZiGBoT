'use client';

import { useCallback, useEffect, useState } from 'react';

async function call(url, options = {}) {
    const res = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json' }, cache: 'no-store' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(body.error || 'Something went wrong.'), { body });
    return body;
}

function Diff({ lines }) {
    return (
        <pre style={{ maxHeight: 320, overflow: 'auto', fontSize: 12, margin: 0 }}>
            {lines.map((l, i) => <div key={i} style={{ background: l.type === 'add' ? 'rgba(34,197,94,.18)' : l.type === 'del' ? 'rgba(239,68,68,.18)' : 'transparent' }}>{l.type === 'add' ? '+ ' : l.type === 'del' ? '- ' : '  '}{l.text}</div>)}
        </pre>
    );
}

// showPrompt: the built-in (ZiGBoT model) prompt box; off by default because
// prompts use the owner's own API key (AgentBuilder). The list below stays.
export default function AiCreator({ projectId, showPrompt = false }) {
    const base = `/api/studio/projects/${projectId}/ai`;
    const [state, setState] = useState(null);
    const [text, setText] = useState('');
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState(null);

    const load = useCallback(() => call(base).then(setState).catch((e) => setMessage({ error: e.message })), [base]);
    useEffect(() => { load(); }, [load]);

    async function ask(e) {
        e.preventDefault();
        setBusy(true); setMessage(null);
        try { await call(base, { method: 'POST', body: JSON.stringify({ request: text }) }); setText(''); setMessage({ ok: 'Proposal ready. Review the changes, then approve or reject.' }); await load(); }
        catch (err) { setMessage({ error: err.message, rejected: err.body?.rejected }); await load(); }
        finally { setBusy(false); }
    }
    async function decide(p, decision) {
        if (decision === 'approve' && !window.confirm(`Write ${p.changes.length} change(s) into the project? Each changed file is snapshotted first.`)) return;
        try {
            const r = await call(`${base}/${p.id}`, { method: 'POST', body: JSON.stringify({ decision }) });
            setMessage({ ok: decision === 'approve' ? `Approved: wrote ${r.written.length} file(s)${r.deleted.length ? `, deleted ${r.deleted.length}` : ''}. Nothing was deployed.` : 'Rejected. Nothing was changed.' });
            load();
        } catch (e) { setMessage({ error: e.message }); load(); }
    }

    if (!state && !message) return <p className="help" aria-busy="true">Loading…</p>;
    return (
        <div className="stack">
            {message?.error ? <div className="error" role="alert">{message.error}{message.rejected?.length ? <ul>{message.rejected.map((r, i) => <li key={i}><code>{r.path || '(no path)'}</code>: {r.reason}</li>)}</ul> : null}</div> : null}
            {message?.ok ? <p className="help" role="status">{message.ok}</p> : null}
            {showPrompt ? (<form className="card stack" onSubmit={ask}>
                <label htmlFor="ai-request"><strong>What should change?</strong></label>
                <textarea id="ai-request" rows={4} maxLength={2000} value={text} onChange={(e) => setText(e.target.value)} placeholder="For example: add a /ping command that replies with the latency" />
                <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                    <button className="btn btn-primary" type="submit" disabled={busy || !text.trim() || state?.remaining === 0} aria-busy={busy}>{busy ? 'Thinking…' : 'Propose changes'}</button>
                    {state ? <span className="help">{state.remaining} of {state.limit} AI requests left today.</span> : null}
                </div>
                <p className="help">The AI only sees this project&apos;s files. It proposes a plan and diffs; nothing is written until you approve, and nothing is ever deployed automatically.</p>
            </form>) : null}
            {(state?.proposals || []).length === 0 ? <p className="help">No proposals yet.</p> : state.proposals.map((p) => (
                <article key={p.id} className="card stack">
                    <div className="row" style={{ justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                        <strong>{p.request.slice(0, 120)}{p.model ? <span className="pill" style={{ marginLeft: 8 }}>{p.model}</span> : null}</strong>
                        <span className="help">{new Date(p.createdAt).toLocaleString()} · {p.status}</span>
                    </div>
                    {p.plan.length ? <ol>{p.plan.map((s, i) => <li key={i}>{s}</li>)}</ol> : null}
                    {p.changes.map((c) => (
                        <details key={c.path} open={p.status === 'pending' && p.changes.length <= 3}>
                            <summary><code>{c.path}</code> ({c.action})</summary>
                            <Diff lines={c.diff} />
                        </details>
                    ))}
                    {p.rejected.length ? <p className="help">Refused by the safety checks: {p.rejected.map((r) => `${r.path || '(no path)'} (${r.reason})`).join('; ')}</p> : null}
                    {p.status === 'pending' ? (
                        <div className="row" style={{ gap: 8 }}>
                            <button className="btn btn-primary" type="button" onClick={() => decide(p, 'approve')}>Approve and write</button>
                            <button className="btn" type="button" onClick={() => decide(p, 'reject')}>Reject</button>
                        </div>
                    ) : null}
                </article>
            ))}
        </div>
    );
}
