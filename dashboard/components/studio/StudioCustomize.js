'use client';

import { useEffect, useState } from 'react';
import customize from '@/lib/studio/customize';

// Studio Phase 3: presence, colour, messages, timezone, commands, a live
// preview, and the bot token. The token field is write-only: once saved the
// page shows only "configured ✓ …abcd", never the token itself.
const { STATUSES, ACTIVITY_TYPES, preview } = customize;

async function call(url, options = {}) {
    const res = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json' }, cache: 'no-store' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
        const error = new Error(body.error || 'Something went wrong.');
        error.fields = body.fieldErrors || {};
        throw error;
    }
    return body;
}

export default function StudioCustomize({ projectId, botName, commands }) {
    const [settings, setSettings] = useState(null);
    const [portalOnly, setPortalOnly] = useState([]);
    const [errors, setErrors] = useState({});
    const [status, setStatus] = useState(null);
    const [token, setToken] = useState({ configured: false });
    const [tokenInput, setTokenInput] = useState('');
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        call(`/api/studio/projects/${projectId}/settings`).then((b) => { setSettings(b.settings); setPortalOnly(b.portalOnly); }).catch((e) => setStatus({ error: e.message }));
        call(`/api/studio/projects/${projectId}/token`).then((b) => setToken(b.token)).catch(() => {});
    }, [projectId]);

    if (!settings) return <div className="card"><p className="help" aria-busy="true">{status?.error || 'Loading…'}</p></div>;
    const set = (path, value) => {
        const next = structuredClone(settings);
        const keys = path.split('.');
        let target = next;
        while (keys.length > 1) target = target[keys.shift()];
        target[keys[0]] = value;
        setSettings(next);
    };
    const view = preview(settings, { botName });

    async function save() {
        setBusy(true);
        setErrors({});
        setStatus(null);
        try {
            const body = await call(`/api/studio/projects/${projectId}/settings`, { method: 'PUT', body: JSON.stringify({ settings }) });
            setSettings(body.settings);
            setStatus({ ok: 'Saved. settings.json in your project was updated.' });
        } catch (e) {
            setErrors(e.fields || {});
            setStatus({ error: e.message });
        } finally {
            setBusy(false);
        }
    }

    async function saveToken() {
        setBusy(true);
        setErrors({});
        try {
            const body = await call(`/api/studio/projects/${projectId}/token`, { method: 'POST', body: JSON.stringify({ token: tokenInput }) });
            setToken(body.token);
            setTokenInput('');
            setStatus({ ok: `Token checked with Discord and saved for ${body.token.meta.botUsername}.` });
        } catch (e) {
            setErrors(e.fields || {});
            setStatus({ error: e.message });
        } finally {
            setBusy(false);
        }
    }

    async function removeToken() {
        setBusy(true);
        try {
            setToken((await call(`/api/studio/projects/${projectId}/token`, { method: 'DELETE' })).token);
            setStatus({ ok: 'Token removed.' });
        } catch (e) {
            setStatus({ error: e.message });
        } finally {
            setBusy(false);
        }
    }

    const err = (key) => (errors[key] ? <span className="error" role="alert">{errors[key]}</span> : null);
    const disabled = new Set(settings.disabledCommands);

    return (
        <div className="grid" style={{ gap: 16 }}>
            <div className="card stack">
                <h2 style={{ marginTop: 0 }}>Presence and look</h2>
                <label className="field" htmlFor="c-status"><span className="label">Online status</span>
                    <select id="c-status" value={settings.presence.status} onChange={(e) => set('presence.status', e.target.value)}>{STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}</select>
                </label>{err('presence.status')}
                <label className="field" htmlFor="c-type"><span className="label">Activity</span>
                    <select id="c-type" value={settings.presence.activityType} onChange={(e) => set('presence.activityType', e.target.value)}>{ACTIVITY_TYPES.map((s) => <option key={s} value={s}>{s}</option>)}</select>
                </label>
                <label className="field" htmlFor="c-text"><span className="label">Activity text (empty = none)</span>
                    <input id="c-text" maxLength={128} value={settings.presence.activityText} onChange={(e) => set('presence.activityText', e.target.value)} />
                </label>{err('presence.activityText')}
                <label className="field" htmlFor="c-color"><span className="label">Embed colour</span>
                    <input id="c-color" type="color" value={settings.embedColor} onChange={(e) => set('embedColor', e.target.value)} />
                </label>{err('embedColor')}
                <label className="field" htmlFor="c-tz"><span className="label">Time zone</span>
                    <input id="c-tz" value={settings.timezone} onChange={(e) => set('timezone', e.target.value)} placeholder="Asia/Kolkata" />
                </label>{err('timezone')}
                {['welcome', 'goodbye', 'error'].map((key) => (
                    <div key={key}>
                        <label className="field" htmlFor={`c-${key}`}><span className="label">{key[0].toUpperCase() + key.slice(1)} message</span>
                            <textarea id={`c-${key}`} rows={2} maxLength={500} value={settings.messages[key]} onChange={(e) => set(`messages.${key}`, e.target.value)} />
                        </label>{err(`messages.${key}`)}
                    </div>
                ))}
                <fieldset className="field" style={{ border: 0, padding: 0 }}>
                    <legend className="label">Slash commands</legend>
                    {commands.map((c) => (
                        <label key={c} style={{ display: 'block' }}>
                            <input type="checkbox" checked={!disabled.has(c)} onChange={(e) => set('disabledCommands', e.target.checked ? settings.disabledCommands.filter((x) => x !== c) : [...settings.disabledCommands, c])} /> /{c}
                        </label>
                    ))}
                    {err('disabledCommands')}
                </fieldset>
                <button className="btn btn-primary" type="button" onClick={save} disabled={busy}>Save settings</button>
                {status?.error ? <p className="error" role="alert">{status.error}</p> : null}
                {status?.ok ? <p className="help" role="status">{status.ok}</p> : null}
            </div>

            <div className="stack">
                <div className="card" aria-label="Live preview">
                    <h2 style={{ marginTop: 0 }}>Preview</h2>
                    <p><strong>{view.botName}</strong> <span className="pill">BOT</span> · {view.statusLabel}{view.activityLine ? ` · ${view.activityLine}` : ''}</p>
                    <div style={{ borderLeft: `4px solid ${view.embedColor}`, padding: '8px 12px', background: 'var(--panel-2)', borderRadius: 6 }}>{view.welcome}</div>
                    <p className="help" style={{ marginTop: 8 }}>Goodbye: {view.goodbye}<br />On errors: {view.error}</p>
                </div>

                <div className="card stack">
                    <h2 style={{ marginTop: 0 }}>Bot token</h2>
                    {token.configured
                        ? <p>Configured ✓ <code>…{token.last4}</code>{token.meta?.botUsername ? ` (${token.meta.botUsername})` : ''}</p>
                        : <p className="help">Not set. Paste the token from Developer Portal → Bot → Reset Token.</p>}
                    <label className="field" htmlFor="c-token"><span className="label">{token.configured ? 'Replace the token' : 'Token'}</span>
                        <input id="c-token" type="password" autoComplete="off" spellCheck={false} value={tokenInput} onChange={(e) => setTokenInput(e.target.value)} />
                    </label>{err('token')}
                    <p className="help">Checked once with Discord, stored encrypted, never shown again and never included in exports.</p>
                    <div className="row" style={{ gap: 8 }}>
                        <button className="btn btn-primary" type="button" onClick={saveToken} disabled={busy || !tokenInput}>Check and save</button>
                        {token.configured ? <button className="btn btn-danger" type="button" onClick={removeToken} disabled={busy}>Remove</button> : null}
                    </div>
                </div>

                <div className="card">
                    <h2 style={{ marginTop: 0 }}>Changed in the Discord Developer Portal, not here</h2>
                    <ul>{portalOnly.map((p) => <li key={p.what}><strong>{p.what}:</strong> {p.where}</li>)}</ul>
                </div>
            </div>
        </div>
    );
}
