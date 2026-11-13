'use client';

import { useEffect } from 'react';

// Shown when a page crashes while rendering. No error details reach the
// visitor (they may contain internals); the digest lets us find the log line.
export default function PageError({ error, reset }) {
    useEffect(() => { console.error('[page error]', error?.digest || ''); }, [error]);
    return (
        <div className="shell" style={{ paddingTop: 48 }}>
            <div className="card stack" role="alert" style={{ maxWidth: 560 }}>
                <h1 style={{ margin: 0 }}>Something went wrong</h1>
                <p className="muted">This page hit an error. Your settings and projects are safe.</p>
                {error?.digest ? <p className="help">Reference: <code>{error.digest}</code></p> : null}
                <div className="row" style={{ gap: 8 }}>
                    <button className="btn btn-primary" type="button" onClick={() => reset()}>Try again</button>
                    <a className="btn" href="/dashboard">Go to the dashboard</a>
                </div>
            </div>
        </div>
    );
}
