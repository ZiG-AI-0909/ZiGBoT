'use client';

import { useCallback, useEffect, useState } from 'react';

async function call(url, options = {}) {
    const res = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json' }, cache: 'no-store' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(body.error || 'Something went wrong.'), { body });
    return body;
}

const STATE_LABEL = { unknown: 'Unknown', installing: 'Installing…', running: 'Running', stopped: 'Stopped', crashed: 'Crashed' };

function Copy({ text }) {
    const [done, setDone] = useState(false);
    return <button className="btn cmd-copy" type="button" onClick={() => { navigator.clipboard?.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1500); }, () => {}); }}>{done ? 'Copied ✓' : 'Copy'}</button>;
}

function SelfHosted({ projectId }) {
    const base = `/api/studio/projects/${projectId}/runners`;
    const [state, setState] = useState(null);
    const [message, setMessage] = useState(null);
    const [name, setName] = useState('');
    const [pairing, setPairing] = useState(null);

    const load = useCallback(() => call(base).then(setState).catch((e) => setMessage({ error: e.message })), [base]);
    useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, [load]);

    async function add(e) {
        e.preventDefault();
        try { const r = await call(base, { method: 'POST', body: JSON.stringify({ action: 'add', name }) }); setPairing(r); setName(''); load(); } catch (err) { setMessage({ error: err.message }); }
    }
    async function send(runnerId, command) {
        try { await call(base, { method: 'POST', body: JSON.stringify({ action: 'command', runnerId, command }) }); setMessage({ ok: `${command} sent. The runner picks it up within a few seconds.` }); load(); } catch (e) { setMessage({ error: e.message }); }
    }
    async function remove(r) {
        if (!window.confirm(`Remove the runner "${r.name}"? It will lose access immediately. The bot keeps running on that machine until you stop it there.`)) return;
        try { await call(base, { method: 'POST', body: JSON.stringify({ action: 'remove', runnerId: r.id }) }); load(); } catch (e) { setMessage({ error: e.message }); }
    }

    const site = state?.siteUrl || (typeof window !== 'undefined' ? window.location.origin : '');
    const download = `curl -fsSLO ${site}/runner/zigbot-runner.mjs`;
    return (
        <div className="card stack">
            <h2 style={{ margin: 0 }}>Host it yourself</h2>
            <p className="help">Run your bot on your own VPS, PC or Raspberry Pi with the ZiGBoT runner (Node.js 18+). Studio sends the code and your encrypted variables only to runners you paired, and controls them from here.</p>
            {message?.error ? <p className="error" role="alert">{message.error}</p> : null}
            {message?.ok ? <p className="help" role="status">{message.ok}</p> : null}

            {pairing ? (
                <div className="card stack" style={{ borderColor: 'var(--accent)' }}>
                    <strong>Pair “{pairing.runner.name}”: code {pairing.pairingCode}</strong>
                    <p className="help">Valid for 15 minutes, works once. On your machine, in an empty folder:</p>
                    {[download, `node zigbot-runner.mjs pair ${pairing.pairingCode} --url ${site}`, 'node zigbot-runner.mjs start'].map((c, i) => (
                        <div key={c} className="cmd-example-row"><code className="cmd-example">{i + 1}. {c}</code><Copy text={c} /></div>
                    ))}
                    <p className="help">Keep it running with a process manager (for example <code>pm2 start zigbot-runner.mjs -- start</code> or a systemd service). Then press <strong>Deploy</strong> below.</p>
                    <button className="btn" type="button" onClick={() => setPairing(null)}>Done</button>
                </div>
            ) : null}

            {(state?.runners || []).length === 0 ? <p className="help">No runners yet.</p> : state.runners.map((r) => (
                <div key={r.id} className="card stack">
                    <div className="row" style={{ justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                        <div>
                            <strong>{r.name}</strong>{' '}
                            <span className={`wf-state${r.online && r.state === 'running' ? ' is-active' : r.state === 'crashed' ? ' is-paused' : ''}`}>
                                {r.status === 'pairing' ? 'Waiting for pairing' : r.online ? STATE_LABEL[r.state] : 'Offline'}
                            </span>
                            <div className="help">{r.platform || ''}{r.lastSeenAt ? ` · last seen ${new Date(r.lastSeenAt).toLocaleString()}` : ''}</div>
                        </div>
                        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                            {['deploy', 'start', 'stop', 'restart'].map((c) => <button key={c} className={c === 'deploy' ? 'btn btn-primary' : 'btn'} type="button" disabled={r.status !== 'paired'} onClick={() => send(r.id, c)}>{c[0].toUpperCase() + c.slice(1)}</button>)}
                            <button className="btn btn-danger" type="button" onClick={() => remove(r)}>Remove</button>
                        </div>
                    </div>
                    {(state.commands || []).filter((c) => c.runner_id === r.id).slice(0, 5).map((c) => (
                        <div key={c.id} className="help">#{c.id} {c.action}: {c.status}{c.message ? ` (${c.message})` : ''} · {new Date(c.updated_at).toLocaleTimeString()}</div>
                    ))}
                    <details>
                        <summary>Logs</summary>
                        <pre style={{ maxHeight: 280, overflow: 'auto', fontSize: 12 }}>{(state.logs || []).filter((l) => l.runner_id === r.id).map((l) => `${new Date(l.created_at).toLocaleTimeString()} ${l.level === 'info' ? '' : `[${l.level}] `}${l.line}`).join('\n') || 'No logs yet.'}</pre>
                    </details>
                </div>
            ))}

            <form className="row" style={{ gap: 8, flexWrap: 'wrap' }} onSubmit={add}>
                <label className="sr-only" htmlFor="runner-name">Machine name</label>
                <input id="runner-name" placeholder="Machine name (e.g. My VPS)" maxLength={40} value={name} onChange={(e) => setName(e.target.value)} />
                <button className="btn btn-primary" type="submit">Add a self-hosted runner</button>
            </form>
        </div>
    );
}

export default function Deployments({ projectId }) {
    const base = `/api/studio/projects/${projectId}/deployments`;
    const [state, setState] = useState(null);
    const [error, setError] = useState(null);
    useEffect(() => {
        fetch(base, { cache: 'no-store' }).then((r) => r.json().then((b) => (r.ok ? setState(b) : setError(b.error || 'Could not load deployments.')))).catch(() => setError('Could not load deployments.'));
    }, [base]);
    if (error) return <p className="error" role="alert">{error}</p>;
    if (!state) return <p className="help" aria-busy="true">Loading…</p>;
    const off = !state.hosting.available;
    return (
        <div className="stack">
            <SelfHosted projectId={projectId} />
            <div className="card">
                <h2 style={{ marginTop: 0 }}>ZiGBoT hosting</h2>
                {off ? <p className="help"><strong>Coming soon.</strong> {state.hosting.message} Until then, use a self-hosted runner above.</p> : null}
                <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                    {['Deploy', 'Start', 'Stop', 'Restart', 'Roll back'].map((label) => <button key={label} className="btn" type="button" disabled={off} title={off ? 'Hosting coming soon' : undefined}>{label}</button>)}
                </div>
                <h2>Deployment history</h2>
                {state.deployments.length === 0 ? <p className="help">No hosted deployments yet.</p> : (
                    <ul>{state.deployments.map((d) => <li key={d.id}>v{d.version}: {d.status}{d.sourceVersion ? ` (rollback to v${d.sourceVersion})` : ''}, {d.files} files, {new Date(d.createdAt).toLocaleString()}{d.error ? `: ${d.error}` : ''}</li>)}</ul>
                )}
            </div>
        </div>
    );
}
