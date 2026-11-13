'use client';

import { useEffect, useState } from 'react';

/** Reveal one user's agent key on click; hides again after 30 s. Every reveal is audit-logged server-side. */
export default function RevealKey({ ownerId, provider, last4 }) {
    const [key, setKey] = useState(null);
    const [error, setError] = useState(null);
    const [busy, setBusy] = useState(false);
    useEffect(() => {
        if (!key) return undefined;
        const t = setTimeout(() => setKey(null), 30_000);
        return () => clearTimeout(t);
    }, [key]);

    async function reveal() {
        if (!window.confirm(`Reveal this user's full ${provider} key? The view is recorded in the admin audit log.`)) return;
        setBusy(true); setError(null);
        try {
            const res = await fetch(`/api/admin/agent-keys/${ownerId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider }), cache: 'no-store' });
            const body = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(body.error || 'Could not reveal the key.');
            setKey(body.key);
        } catch (e) { setError(e.message); } finally { setBusy(false); }
    }

    if (key) {
        return (
            <span className="row" style={{ gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                <code style={{ wordBreak: 'break-all', userSelect: 'all' }}>{key}</code>
                <button className="btn btn-ghost" type="button" onClick={() => navigator.clipboard?.writeText(key)}>Copy</button>
                <button className="btn btn-ghost" type="button" onClick={() => setKey(null)}>Hide</button>
            </span>
        );
    }
    return (
        <span className="row" style={{ gap: 6, alignItems: 'center' }}>
            <code>••••{last4}</code>
            <button className="btn btn-ghost" type="button" onClick={reveal} disabled={busy}>{busy ? '…' : 'Reveal'}</button>
            {error ? <span className="error" role="alert">{error}</span> : null}
        </span>
    );
}
