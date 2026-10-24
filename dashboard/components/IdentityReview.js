'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

async function post(body) {
    const response = await fetch('/api/owner/identity', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        cache: 'no-store'
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
    return data;
}

function PendingCard({ item, run, busy }) {
    const [note, setNote] = useState('');
    const key = item.guild_id;
    return (
        <div className="card identity-review">
            <div className="row" style={{ alignItems: 'flex-start' }}>
                <img className="identity-avatar identity-avatar-lg" src={`/api/guilds/${key}/identity/avatar?slot=pending`} alt={`Pending avatar for ${item.guild_name}`} width="128" height="128" />
                <div className="stack" style={{ flex: 1, minWidth: 0 }}>
                    <h3 style={{ margin: 0 }}>{item.guild_name}</h3>
                    <p className="help" style={{ margin: 0 }}>Server {key} · uploaded by {item.pending_submitted_by || 'unknown'} · {item.pending_submitted_at ? new Date(item.pending_submitted_at).toLocaleString() : ''}</p>
                    <p className="small" style={{ margin: 0 }}>Name: <strong>{item.nick || 'ZiGBoT (default)'}</strong>{item.bio ? <> · Bio: {item.bio}</> : null}</p>
                    <label className="help" htmlFor={`note-${key}`}>Note to the admins if you reject it (optional)</label>
                    <input id={`note-${key}`} type="text" maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} />
                    <div className="row">
                        <button className="btn btn-primary" disabled={Boolean(busy)} onClick={() => run({ action: 'approve', guildId: key })}>Approve</button>
                        <button className="btn btn-danger" disabled={Boolean(busy)} onClick={() => run({ action: 'reject', guildId: key, note })}>Reject</button>
                        <button className="btn" disabled={Boolean(busy)} onClick={() => run({ action: 'block', kind: 'guild', guildId: key, reason: note }, 'Block this server from custom identity and reset its bot profile?')}>Block server</button>
                        {item.pending_submitted_by ? (
                            <button className="btn" disabled={Boolean(busy)} onClick={() => run({ action: 'block', kind: 'user', guildId: key, targetId: item.pending_submitted_by, reason: note }, 'Block this admin from changing ZiGBoT’s identity anywhere?')}>Block uploader</button>
                        ) : null}
                    </div>
                </div>
            </div>
        </div>
    );
}

export default function IdentityReview({ pending, blocks }) {
    const router = useRouter();
    const [busy, setBusy] = useState(null);
    const [message, setMessage] = useState(null);

    async function run(body, confirmText) {
        if (confirmText && !window.confirm(confirmText)) return;
        setBusy(body.guildId);
        setMessage(null);
        try {
            const result = await post(body);
            setMessage({ kind: result.warning ? 'warn' : 'ok', text: result.warning || 'Done.' });
            router.refresh();
        } catch (error) {
            setMessage({ kind: 'err', text: error.message });
        } finally {
            setBusy(null);
        }
    }

    return (
        <div className="stack" style={{ marginTop: 16 }}>
            {message ? <div className="notice" role={message.kind === 'err' ? 'alert' : 'status'}>{message.text}</div> : null}
            <h2>Waiting for review ({pending.length})</h2>
            {pending.length === 0 ? <div className="card empty"><p className="muted" style={{ margin: 0 }}>Nothing to review.</p></div> : null}
            {pending.map((item) => <PendingCard key={item.guild_id} item={item} run={run} busy={busy} />)}

            <h2 style={{ marginTop: 24 }}>Blocks ({blocks.length})</h2>
            {blocks.length === 0 ? <div className="card empty"><p className="muted" style={{ margin: 0 }}>No blocks.</p></div> : (
                <div className="card audit">
                    {blocks.map((b) => (
                        <div key={b.id} className="audit-row">
                            <span><strong>{b.kind === 'guild' ? 'Server' : 'User'}</strong> {b.target_id}{b.reason ? ` · ${b.reason}` : ''}</span>
                            <span className="row">
                                <span className="help">{new Date(b.created_at).toLocaleString()}</span>
                                <button className="btn btn-ghost" disabled={Boolean(busy)} onClick={() => run({ action: 'unblock', kind: b.kind, guildId: b.context_guild_id, targetId: b.target_id })}>Unblock</button>
                            </span>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
