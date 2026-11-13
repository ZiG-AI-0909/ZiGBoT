'use client';

import { useEffect, useState } from 'react';

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
            {off ? (
                <div className="card" role="status">
                    <strong>Hosting coming soon</strong>
                    <p className="help">{state.hosting.message}</p>
                    <a className="btn" href={`/api/studio/projects/${projectId}/export`}>Download project (.zip)</a>
                </div>
            ) : null}
            <div className="card">
                <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                    {['Deploy', 'Start', 'Stop', 'Restart', 'Roll back'].map((label) => <button key={label} className="btn" type="button" disabled={off} title={off ? 'Hosting coming soon' : undefined}>{label}</button>)}
                </div>
                <h2>Logs and metrics</h2>
                <p className="help">{off ? 'Not available until hosting exists.' : 'Live logs appear here.'}</p>
                <h2>Deployment history</h2>
                {state.deployments.length === 0 ? <p className="help">No deployments yet.</p> : (
                    <ul>{state.deployments.map((d) => <li key={d.id}>v{d.version}: {d.status}{d.sourceVersion ? ` (rollback to v${d.sourceVersion})` : ''}, {d.files} files, {new Date(d.createdAt).toLocaleString()}{d.error ? `: ${d.error}` : ''}</li>)}</ul>
                )}
            </div>
        </div>
    );
}
