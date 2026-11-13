'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

async function call(url, options = {}) {
    const res = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json' }, cache: 'no-store' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(body.error || 'Something went wrong.'), { body, status: res.status });
    return body;
}

const LANG = { javascript: 'JavaScript (discord.js)', typescript: 'TypeScript (discord.js)', python: 'Python (discord.py)' };

/**
 * "Build with AI Coding Agent": connect your own Claude or OpenAI key,
 * describe what to build, get a plan + diffs + static check results as a
 * proposal below (approve to write). Cancel aborts the agent call.
 */
export default function AgentBuilder({ projectId, language, onProposal }) {
    const [info, setInfo] = useState(null);
    const [provider, setProvider] = useState('anthropic');
    const [model, setModel] = useState('');
    const [projectType, setProjectType] = useState('feature');
    const [prompt, setPrompt] = useState('');
    const [keyDraft, setKeyDraft] = useState('');
    const [busy, setBusy] = useState(false);
    const [elapsed, setElapsed] = useState(0);
    const [result, setResult] = useState(null);
    const [message, setMessage] = useState(null);
    const [runs, setRuns] = useState([]);
    const abortRef = useRef(null);

    const load = useCallback(() => {
        call('/api/studio/agents/keys').then(setInfo).catch((e) => setMessage({ error: e.message }));
        call(`/api/studio/projects/${projectId}/agent`).then((b) => setRuns(b.runs)).catch(() => {});
    }, [projectId]);
    useEffect(() => { load(); }, [load]);
    useEffect(() => {
        if (!busy) return undefined;
        const t0 = Date.now();
        const t = setInterval(() => setElapsed(Math.round((Date.now() - t0) / 1000)), 500);
        return () => clearInterval(t);
    }, [busy]);

    const p = info?.providers.find((x) => x.id === provider);
    useEffect(() => { if (p) setModel(p.model || p.defaultModel || ''); }, [p?.id, p?.model]); // eslint-disable-line react-hooks/exhaustive-deps

    async function saveKey(e) {
        e.preventDefault();
        try { await call('/api/studio/agents/keys', { method: 'PUT', body: JSON.stringify({ provider, apiKey: keyDraft, model: model || undefined }) }); setKeyDraft(''); setMessage({ ok: 'Key saved (encrypted). It will not be shown again.' }); load(); } catch (err) { setMessage({ error: err.message }); }
    }
    async function removeKey() {
        if (!window.confirm('Remove this key from ZiGBoT?')) return;
        try { await call('/api/studio/agents/keys', { method: 'DELETE', body: JSON.stringify({ provider }) }); load(); } catch (err) { setMessage({ error: err.message }); }
    }
    async function generate(e) {
        e.preventDefault();
        const controller = new AbortController();
        abortRef.current = controller;
        setBusy(true); setMessage(null); setResult(null); setElapsed(0);
        try {
            const r = await call(`/api/studio/projects/${projectId}/agent`, { method: 'POST', body: JSON.stringify({ provider, model, request: prompt, projectType }), signal: controller.signal });
            setResult(r);
            setMessage({ ok: `Proposal ready from ${r.model} (${r.usage.input.toLocaleString()} in / ${r.usage.output.toLocaleString()} out tokens). Review it below, then approve or reject.` });
            onProposal?.();
        } catch (err) {
            setMessage(err.name === 'AbortError' ? { ok: 'Cancelled. Nothing was changed.' } : { error: err.message, rejected: err.body?.rejected });
        } finally {
            setBusy(false); abortRef.current = null; load();
        }
    }

    if (!info) return message?.error ? <p className="error" role="alert">{message.error}</p> : <p className="help" aria-busy="true">Loading agents…</p>;
    return (
        <section className="card stack" aria-labelledby="agent-title">
            <h2 id="agent-title" style={{ margin: 0 }}>Build with AI Coding Agent</h2>
            <p className="help">Use your own Claude or OpenAI account. The agent sees only this project&apos;s files, proposes a plan and diffs, and nothing is written until you approve. Generated code never runs on ZiGBoT&apos;s servers.</p>
            {message?.error ? <div className="error" role="alert">{message.error}{message.rejected?.length ? <ul>{message.rejected.map((r, i) => <li key={i}><code>{r.path || '(no path)'}</code>: {r.reason}</li>)}</ul> : null}</div> : null}
            {message?.ok ? <p className="help" role="status">{message.ok}</p> : null}

            <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
                <div className="field"><label htmlFor="agent-provider">Agent</label>
                    <select id="agent-provider" value={provider} onChange={(e) => setProvider(e.target.value)} disabled={busy}>
                        {info.providers.map((x) => <option key={x.id} value={x.id}>{x.label}{x.configured ? ' ✓' : ''}</option>)}
                    </select>
                </div>
                <div className="field"><label htmlFor="agent-model">Model</label>
                    {p?.models ? (
                        <select id="agent-model" value={model} onChange={(e) => setModel(e.target.value)} disabled={busy}>{p.models.map((m) => <option key={m} value={m}>{m}</option>)}</select>
                    ) : <input id="agent-model" value={model} maxLength={64} placeholder="model id from your OpenAI account" onChange={(e) => setModel(e.target.value)} disabled={busy} />}
                </div>
                <div className="field"><label htmlFor="agent-lang">Language</label><input id="agent-lang" value={LANG[language] || language} readOnly /></div>
                <div className="field"><label htmlFor="agent-type">Project type</label>
                    <select id="agent-type" value={projectType} onChange={(e) => setProjectType(e.target.value)} disabled={busy}>{info.projectTypes.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}</select>
                </div>
            </div>

            {p?.configured ? (
                <p className="help">Key connected ✓ …{p.last4} <button type="button" className="link" onClick={removeKey}>remove</button></p>
            ) : (
                <form className="row" style={{ gap: 8, flexWrap: 'wrap' }} onSubmit={saveKey}>
                    <label className="sr-only" htmlFor="agent-key">API key</label>
                    <input id="agent-key" type="password" autoComplete="off" placeholder={p?.keyHint} value={keyDraft} onChange={(e) => setKeyDraft(e.target.value)} style={{ minWidth: 280, flex: 1 }} />
                    <button className="btn" type="submit" disabled={!keyDraft}>Connect key</button>
                    <p className="help" style={{ width: '100%', margin: 0 }}>Stored encrypted. ZiGBoT administrators can view saved keys (every view is logged), so consider a key with a spending limit. <a href="/privacy">Privacy Policy</a></p>
                </form>
            )}

            <form className="stack" onSubmit={generate}>
                <label htmlFor="agent-prompt"><strong>What should the agent build?</strong></label>
                <textarea id="agent-prompt" rows={4} maxLength={2000} value={prompt} onChange={(e) => setPrompt(e.target.value)} disabled={busy}
                    placeholder="For example: a moderation bot with an AI-powered warning system, warnings stored per member, and an admin command to review them" />
                <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                    <button className="btn btn-primary" type="submit" disabled={busy || !p?.configured || !prompt.trim()} aria-busy={busy}>{busy ? `Generating… ${elapsed}s` : 'Generate code'}</button>
                    {busy ? <button className="btn" type="button" onClick={() => abortRef.current?.abort()}>Cancel</button> : null}
                </div>
            </form>

            {result?.checks ? (
                <div className="stack" aria-live="polite">
                    <strong>Checks on the proposed code (static, nothing was run)</strong>
                    {result.checks.map((c) => (
                        <div key={c.id}>
                            {c.label}: {c.ok ? 'no problems ✓' : `${c.problems.length} problem(s)`}
                            {!c.ok ? <ul className="help">{c.problems.slice(0, 8).map((x, i) => <li key={i}>{x.path}{x.line ? `:${x.line}` : ''} {x.message}</li>)}</ul> : null}
                        </div>
                    ))}
                    <p className="help">Not happy? Edit your request and generate again: each run is a new proposal you can reject.</p>
                </div>
            ) : null}

            <details>
                <summary>Not available here</summary>
                <ul className="help">{info.notAvailable.map((n) => <li key={n.id}><strong>{n.label}:</strong> {n.reason}</li>)}</ul>
            </details>
            {runs.length ? (
                <details>
                    <summary>Usage ({runs.length} recent runs)</summary>
                    <ul className="help">{runs.map((r) => <li key={r.id}>{new Date(r.created_at).toLocaleString()} · {r.model} · {r.status}{r.status === 'done' ? ` · ${r.input_tokens + r.output_tokens} tokens · ${Math.round((r.duration_ms || 0) / 1000)}s` : r.error ? ` · ${r.error}` : ''}</li>)}</ul>
                </details>
            ) : null}
        </section>
    );
}
