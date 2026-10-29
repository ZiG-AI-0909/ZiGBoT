'use client';

import { useState } from 'react';

// Forms & Responses: review status, private note, archive. The customer's
// answers are never edited, and responses are archived, never deleted.
// Every action is authorized again on the server and audit-logged.

async function patch(path, body) {
    const response = await fetch(path, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
    return data;
}

export default function ReviewActions({ response }) {
    const [state, setState] = useState({ review_status: response.review_status, archived_at: response.archived_at, admin_note: response.admin_note || '' });
    const [note, setNote] = useState(response.admin_note || '');
    const [busy, setBusy] = useState(null);
    const [message, setMessage] = useState(null);
    const [confirmArchive, setConfirmArchive] = useState(false);
    const path = `/api/admin/feedback/${response.id}`;

    async function run(kind, body) {
        setBusy(kind);
        setMessage(null);
        try {
            const { response: updated } = await patch(path, body);
            setState({ review_status: updated.review_status, archived_at: updated.archived_at, admin_note: updated.admin_note || '' });
            setMessage({ ok: true, text: 'Saved.' });
            setConfirmArchive(false);
        } catch (error) {
            setMessage({ ok: false, text: error.message });
        } finally {
            setBusy(null);
        }
    }

    return (
        <section className="card stack" aria-label="Review">
            <h2 style={{ margin: 0 }}>Review</h2>
            <div className="row">
                <span>Status: <strong>{state.review_status}</strong>{state.archived_at ? ' · archived' : ''}</span>
                {state.review_status === 'new'
                    ? <button className="btn btn-primary" type="button" disabled={Boolean(busy)} onClick={() => run('review', { review_status: 'reviewed' })}>Mark as Reviewed</button>
                    : <button className="btn" type="button" disabled={Boolean(busy)} onClick={() => run('review', { review_status: 'new' })}>Mark as Unreviewed</button>}
                {state.archived_at
                    ? <button className="btn" type="button" disabled={Boolean(busy)} onClick={() => run('archive', { archived: false })}>Restore from archive</button>
                    : confirmArchive
                        ? (
                            <span className="row" role="alertdialog" aria-label="Confirm archive">
                                <span className="help">Archive this response? It stays stored and can be restored.</span>
                                <button className="btn btn-danger" type="button" disabled={Boolean(busy)} onClick={() => run('archive', { archived: true })}>Yes, archive</button>
                                <button className="btn" type="button" onClick={() => setConfirmArchive(false)}>Cancel</button>
                            </span>
                        )
                        : <button className="btn" type="button" disabled={Boolean(busy)} onClick={() => setConfirmArchive(true)}>Archive</button>}
            </div>
            <label className="field" htmlFor="admin-note">
                <span className="label">Private admin note</span>
                <span className="help">Only Super Admins see this. It is never shown to the customer and is not included in CSV exports.</span>
                <textarea id="admin-note" rows={3} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} />
            </label>
            <div className="row">
                <button className="btn" type="button" disabled={Boolean(busy) || note === state.admin_note} onClick={() => run('note', { admin_note: note })}>{busy === 'note' ? 'Saving…' : 'Save note'}</button>
                {message ? <span className={message.ok ? 'help' : 'error'} role="status">{message.text}</span> : null}
            </div>
        </section>
    );
}
