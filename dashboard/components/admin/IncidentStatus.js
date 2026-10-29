'use client';

import { useState } from 'react';

// Super Admin triage of one Anti-Nuke incident (authorized and audit-logged on the server).
export default function IncidentStatus({ id, status }) {
    const [current, setCurrent] = useState(status);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);

    async function set(next) {
        setBusy(true);
        setError(null);
        try {
            const response = await fetch(`/api/admin/security/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: next }), cache: 'no-store' });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(data.error || 'Update failed.');
            setCurrent(data.event.status);
        } catch (e) {
            setError(e.message);
        } finally {
            setBusy(false);
        }
    }

    return (
        <span className="row" style={{ gap: 6 }}>
            <strong>{current}</strong>
            {current !== 'acknowledged' && current !== 'resolved' ? <button className="btn" type="button" disabled={busy} onClick={() => set('acknowledged')}>Acknowledge</button> : null}
            {current !== 'resolved' ? <button className="btn" type="button" disabled={busy} onClick={() => set('resolved')}>Resolve</button> : <button className="btn" type="button" disabled={busy} onClick={() => set('open')}>Reopen</button>}
            {error ? <span className="error" role="alert">{error}</span> : null}
        </span>
    );
}
