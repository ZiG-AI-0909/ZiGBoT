'use client';

import { useState } from 'react';
import features from '@/lib/shared/features';

// "Add-ons" tab of the GuildEditor: the optional features, drawn from the
// same field list the server validates with (lib/shared/features.js), so a
// new setting never needs new form code. Everything is off until switched on.
const { FEATURE_SECTIONS } = features;
const CHANNEL_KIND = { 0: '#', 2: '🔊', 4: '📁', 5: '📢', 13: '🎤', 15: '💬' };

function Control({ field, value, onChange, channels, roles, id, error }) {
    const describedBy = error ? `${id}-error` : undefined;
    let input;
    if (field.type === 'bool') {
        return (
            <label className="switch" htmlFor={id}>
                <input id={id} type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} />
                <span className="track" aria-hidden="true" />
                <span><span className="label" style={{ display: 'block' }}>{field.label}</span>{field.help ? <span className="help">{field.help}</span> : null}</span>
            </label>
        );
    }
    if (field.type === 'int') {
        input = <input id={id} type="number" min={field.min} max={field.max} value={value ?? ''} aria-describedby={describedBy} onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))} />;
    } else if (field.type === 'text') {
        input = field.max > 120
            ? <textarea id={id} rows={3} maxLength={field.max} value={value ?? ''} aria-describedby={describedBy} onChange={(e) => onChange(e.target.value)} />
            : <input id={id} type="text" maxLength={field.max} value={value ?? ''} aria-describedby={describedBy} onChange={(e) => onChange(e.target.value)} />;
    } else if (field.type === 'enum') {
        input = <select id={id} value={value ?? field.default} aria-describedby={describedBy} onChange={(e) => onChange(e.target.value)}>{field.options.map((o) => <option key={o} value={o}>{o}</option>)}</select>;
    } else if (field.type === 'channel' || field.type === 'role') {
        const list = field.type === 'channel' ? channels : roles;
        input = (
            <select id={id} value={value ?? ''} aria-describedby={describedBy} onChange={(e) => onChange(e.target.value || null)}>
                <option value="">Not set</option>
                {list.map((item) => <option key={item.id} value={item.id}>{field.type === 'channel' ? `${CHANNEL_KIND[item.type] || '#'} ${item.name}` : item.name}</option>)}
            </select>
        );
    } else if (field.type === 'channels' || field.type === 'roles') {
        const list = field.type === 'channels' ? channels : roles;
        const picked = new Set(value || []);
        return (
            <div className="field">
                <span className="label" id={`${id}-label`}>{field.label}</span>
                <div className="checklist" role="group" aria-labelledby={`${id}-label`}>
                    {list.length === 0 ? <span className="help" style={{ padding: 8 }}>Nothing to pick from.</span> : null}
                    {list.map((item) => (
                        <label key={item.id}>
                            <input type="checkbox" checked={picked.has(item.id)} disabled={!picked.has(item.id) && picked.size >= field.max}
                                onChange={(e) => onChange(e.target.checked ? [...picked, item.id] : [...picked].filter((x) => x !== item.id))} />
                            <span>{item.name}</span>
                        </label>
                    ))}
                </div>
                {error ? <span className="error" role="alert" id={`${id}-error`}>{error}</span> : null}
            </div>
        );
    } else if (field.type === 'list') {
        // Rows of sub-fields (rules, scheduled messages...): add, edit, remove.
        const rows = Array.isArray(value) ? value : [];
        const blank = () => Object.fromEntries(field.itemFields.map((f) => [f.key, Array.isArray(f.default) ? [] : f.default]));
        const change = (index, key, next) => onChange(rows.map((row, i) => (i === index ? { ...row, [key]: next } : row)));
        return (
            <fieldset className="field" style={{ border: '1px solid var(--border)', borderRadius: 12, padding: 12 }}>
                <legend className="label">{field.label} ({rows.length}/{field.max})</legend>
                {rows.length === 0 ? <span className="help">None yet.</span> : null}
                {rows.map((row, index) => (
                    <div key={index} className="grid" style={{ gap: 8, padding: '10px 0', borderTop: index ? '1px solid var(--border)' : 'none' }}>
                        <strong>#{index + 1}</strong>
                        {field.itemFields.map((sub) => (
                            <Control key={sub.key} field={sub} id={`${id}-${index}-${sub.key}`} value={row[sub.key]} onChange={(next) => change(index, sub.key, next)} channels={channels} roles={roles} />
                        ))}
                        <button type="button" className="btn btn-danger" onClick={() => onChange(rows.filter((_, i) => i !== index))}>Remove #{index + 1}</button>
                    </div>
                ))}
                <button type="button" className="btn" disabled={rows.length >= field.max} onClick={() => onChange([...rows, blank()])}>Add</button>
                {error ? <span className="error" role="alert" id={`${id}-error`}>{error}</span> : null}
            </fieldset>
        );
    } else {
        return null;
    }
    return (
        <div className="field">
            <label className="label" htmlFor={id}>{field.label}</label>
            {field.help ? <span className="help">{field.help}</span> : null}
            {input}
            {error ? <span className="error" role="alert" id={`${id}-error`}>{error}</span> : null}
        </div>
    );
}

// Settings backup (server owner only; enforced by the API routes).
function BackupCard({ guildId }) {
    const [status, setStatus] = useState(null);
    async function importFile(event) {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (!file) return;
        if (file.size > 200 * 1024) return setStatus({ error: 'The file is larger than 200 KB.' });
        setStatus({ busy: true });
        try {
            const res = await fetch(`/api/guilds/${guildId}/config/import`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: await file.text() });
            const body = await res.json().catch(() => ({}));
            if (!res.ok) {
                const fields = body.fieldErrors ? Object.entries(body.fieldErrors).slice(0, 5).map(([k, v]) => `${k}: ${v}`).join('; ') : '';
                return setStatus({ error: `${body.error || 'Import failed.'}${fields ? ` ${fields}` : ''}` });
            }
            setStatus({ ok: 'Settings restored. Reloading…' });
            window.location.reload();
        } catch {
            setStatus({ error: 'Import failed. Check your connection and try again.' });
        }
    }
    return (
        <div className="card" style={{ marginBottom: 16 }}>
            <h2>Backup</h2>
            <p className="help">Server owner only. Download every ZiGBoT setting of this server as a JSON file, or restore one. A restore is checked like a normal save, against this server's channels and roles.</p>
            <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
                <a className="btn" href={`/api/guilds/${guildId}/config/export`} download>Export settings</a>
                <label className="btn" htmlFor="addons-import">Import settings
                    <input id="addons-import" type="file" accept="application/json,.json" onChange={importFile} style={{ position: 'absolute', width: 1, height: 1, opacity: 0 }} disabled={status?.busy} />
                </label>
            </div>
            {status?.error ? <p className="error" role="alert">{status.error}</p> : null}
            {status?.ok ? <p className="help" role="status">{status.ok}</p> : null}
        </div>
    );
}

export default function AddonsTab({ draft, set, errors, channels, roles, guildId }) {
    const names = Object.keys(FEATURE_SECTIONS);
    const [open, setOpen] = useState(names[0]);
    const all = draft.feature_settings || {};
    const update = (section, key) => (value) => set('feature_settings')({ ...all, [section]: { ...(all[section] || {}), [key]: value } });
    const errorCount = (section) => Object.keys(errors || {}).filter((k) => k.startsWith(`feature_settings.${section}.`)).length;

    return (
        <>
        {guildId ? <BackupCard guildId={guildId} /> : null}
        <div className="card">
            <h2>Add-ons</h2>
            <p className="help">Optional features. Everything here is off until you switch it on, and each one works only in this server.</p>
            <div className="tabs" role="tablist" aria-label="Add-on sections" style={{ marginBottom: 16 }}>
                {names.map((name) => (
                    <button key={name} type="button" role="tab" className="tab" aria-selected={open === name} onClick={() => setOpen(name)}>
                        {FEATURE_SECTIONS[name].label}{errorCount(name) ? ` (${errorCount(name)} to fix)` : ''}
                    </button>
                ))}
            </div>
            {errors?.feature_settings ? <span className="error" role="alert">{errors.feature_settings}</span> : null}
            <div className="grid" style={{ gap: 14 }}>
                {FEATURE_SECTIONS[open].fields.map((field) => (
                    <Control key={field.key} field={field} id={`addon-${open}-${field.key}`}
                        value={(all[open] || {})[field.key] ?? field.default}
                        onChange={update(open, field.key)} channels={channels} roles={roles}
                        error={errors?.[`feature_settings.${open}.${field.key}`]} />
                ))}
            </div>
        </div>
        </>
    );
}
