'use client';

import { useCallback, useEffect, useState } from 'react';

// Anti-Nuke (free for every server). Monitoring and alerts are always on;
// this tab only changes WHERE alerts go, how sensitive detection is, who
// is trusted, and which optional automatic actions are allowed. Every
// value is validated again on the server.

const SEVERITY_PILL = { CRITICAL: 'pill-bad', HIGH: 'pill-warn', MEDIUM: '' };
const CONTAINMENT_LABEL = {
    not_enabled: 'Automatic action off',
    not_applicable: 'No automatic action for this type',
    succeeded: 'Contained (verified)',
    partial: 'Partly contained',
    failed: 'Containment failed',
    skipped: 'Containment not possible'
};
const ALERT_LABEL = { sent: 'Alert posted', dm: 'Alert sent to the owner by DM', failed: 'Alert could not be delivered', held: 'Alert held (too many alerts at once)', pending: 'Alert pending' };
const MAINTENANCE_CHOICES = [0, 1, 3, 6];

async function request(path, { method = 'GET', body } = {}) {
    const response = await fetch(path, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        cache: 'no-store'
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        const error = new Error(data.error || `Request failed (${response.status}).`);
        error.data = data;
        throw error;
    }
    return data;
}

function when(iso) {
    return iso ? new Date(iso).toLocaleString() : 'never';
}

function Overview({ data, inviteUrl }) {
    const { status, summary, required } = data;
    let pill = 'pill-warn';
    let label = 'Status unknown';
    if (status.known && !status.monitoring) {
        pill = 'pill-bad';
        label = 'Not monitoring';
    } else if (status.known && status.missingPermissions.length === 0 && status.alertChannelOk) {
        pill = 'pill-ok';
        label = 'Protected: monitoring and alerts active';
    } else if (status.known) {
        label = 'Monitoring active, with gaps';
    }
    const missing = required.filter((p) => status.missingPermissions?.includes(p.name));
    return (
        <div className="card stack" aria-labelledby="an-overview">
            <div className="spread">
                <h2 id="an-overview" style={{ margin: 0 }}>🛡️ Protection overview</h2>
                <span className={`pill ${pill}`}>{label}</span>
            </div>
            <p className="help" style={{ margin: 0 }}>Anti-Nuke is free for every server. Monitoring and alerts are always on; only the optional automatic actions below can be switched off.</p>
            {!status.known ? <div className="notice">{status.reason}</div> : null}
            {status.known && !status.monitoring ? <div className="notice" role="alert">ZiGBoT cannot read this server&apos;s audit log, so it cannot see who did what. Give ZiGBoT the <strong>View Audit Log</strong> permission.</div> : null}
            {status.known && !status.alertChannelOk ? <div className="notice">ZiGBoT cannot post in a security alert channel here. Alerts go to the server owner by DM until you pick a channel ZiGBoT can write in.</div> : null}
            {missing.length ? (
                <div className="stack" style={{ gap: 8 }}>
                    <strong>Missing permissions</strong>
                    <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
                        {missing.map((p) => <li key={p.name}><strong>{p.name}</strong>: needed {p.why}.</li>)}
                    </ul>
                    <p className="help" style={{ margin: 0 }}>Fix: Server Settings → Roles → ZiGBoT and turn these on{inviteUrl ? <>, or <a href={inviteUrl} target="_blank" rel="noreferrer">re-invite ZiGBoT</a> to update its role</> : null}.</p>
                </div>
            ) : null}
            <div className="grid-2">
                <div><div className="help">Incidents (last 7 days)</div><strong style={{ fontSize: 22 }}>{summary.incidents7d}</strong></div>
                <div><div className="help">Open CRITICAL incidents</div><strong style={{ fontSize: 22, color: summary.openCritical ? 'var(--danger)' : undefined }}>{summary.openCritical}</strong></div>
                <div><div className="help">Last audit event processed</div><span>{when(status.lastEventAt)}</span></div>
                <div><div className="help">Last status check</div><span>{when(status.lastCheckedAt)}</span></div>
            </div>
            <details>
                <summary className="small">What Anti-Nuke can and cannot do</summary>
                <ul className="help" style={{ paddingLeft: 18 }}>
                    <li>Discord reports most actions after they happen. ZiGBoT detects and alerts within seconds; it cannot stop an action before Discord carries it out.</li>
                    <li>Deleted channels, roles and messages cannot be restored by Discord or by ZiGBoT. Keep your own notes or backups of important setup.</li>
                    <li>Detection counts bursts inside a rolling window. After a bot restart the window starts empty; incidents already recorded are kept.</li>
                    <li>Without View Audit Log, ZiGBoT cannot tell who did something, so nothing is detected except join bursts.</li>
                </ul>
            </details>
        </div>
    );
}

function Incidents({ guildId, toast }) {
    const [filters, setFilters] = useState({ severity: '', status: '', actor: '' });
    const [state, setState] = useState({ loading: true, events: [], next: null, error: null });
    const [open, setOpen] = useState(null);
    const [busy, setBusy] = useState(null);

    const query = useCallback((before = null) => {
        const params = new URLSearchParams();
        for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value.trim());
        if (before) params.set('before', String(before));
        return `/api/guilds/${guildId}/antinuke/events?${params.toString()}`;
    }, [filters, guildId]);

    const load = useCallback(async (before = null) => {
        setState((s) => ({ ...s, loading: true, error: null }));
        try {
            const data = await request(query(before));
            setState((s) => ({ loading: false, error: null, events: before ? [...s.events, ...data.events] : data.events, next: data.nextBefore }));
        } catch (error) {
            setState((s) => ({ ...s, loading: false, error: error.message }));
        }
    }, [query]);

    useEffect(() => {
        load();
    }, [load]);

    async function mark(id, status) {
        setBusy(id);
        try {
            await request(`/api/guilds/${guildId}/antinuke/events/${id}`, { method: 'PATCH', body: { status } });
            setState((s) => ({ ...s, events: s.events.map((e) => (e.id === id ? { ...e, status } : e)) }));
            toast(`Incident marked ${status}.`);
        } catch (error) {
            toast(error.message, 'err');
        } finally {
            setBusy(null);
        }
    }

    const exportParams = new URLSearchParams({ export: '1' });
    for (const [key, value] of Object.entries(filters)) if (value) exportParams.set(key, value.trim());

    return (
        <div className="card stack" aria-labelledby="an-incidents">
            <div className="spread">
                <h2 id="an-incidents" style={{ margin: 0 }}>Incident history</h2>
                <a className="btn" href={`/api/guilds/${guildId}/antinuke/events?${exportParams.toString()}`}>Export JSON</a>
            </div>
            <form className="row" onSubmit={(e) => { e.preventDefault(); load(); }}>
                <label className="field" style={{ minWidth: 140 }}>
                    <span className="help">Severity</span>
                    <select value={filters.severity} onChange={(e) => setFilters({ ...filters, severity: e.target.value })}>
                        <option value="">All</option><option>CRITICAL</option><option>HIGH</option><option>MEDIUM</option>
                    </select>
                </label>
                <label className="field" style={{ minWidth: 140 }}>
                    <span className="help">Status</span>
                    <select value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })}>
                        <option value="">All</option><option value="open">Open</option><option value="acknowledged">Acknowledged</option><option value="resolved">Resolved</option>
                    </select>
                </label>
                <label className="field" style={{ flex: 1, minWidth: 180 }}>
                    <span className="help">Actor (Discord user ID)</span>
                    <input value={filters.actor} inputMode="numeric" placeholder="e.g. 123456789012345678" onChange={(e) => setFilters({ ...filters, actor: e.target.value })} />
                </label>
                <button className="btn" type="submit">Search</button>
            </form>
            {state.error ? <div className="notice" role="alert">{state.error}</div> : null}
            {!state.loading && state.events.length === 0 && !state.error ? <div className="empty"><p className="muted" style={{ margin: 0 }}>No incidents match. Quiet is good. 🛡️</p></div> : null}
            <div className="audit">
                {state.events.map((e) => (
                    <div key={e.id} className="audit-row">
                        <div className="spread">
                            <span><span className={`pill ${SEVERITY_PILL[e.severity]}`}>{e.severity}</span> <strong>{e.title}</strong>{e.occurrences > 1 ? <span className="help"> ×{e.occurrences}</span> : null}</span>
                            <span className="help">{when(e.created_at)}</span>
                        </div>
                        <span className="help">{e.actor_id ? <>Actor <code>{e.actor_id}</code>{e.actor_is_bot ? ' (bot)' : ''} · </> : null}{CONTAINMENT_LABEL[e.containment_status] || e.containment_status} · {ALERT_LABEL[e.alert_status] || e.alert_status} · <strong>{e.status}</strong></span>
                        <div className="row">
                            <button className="btn btn-ghost" type="button" aria-expanded={open === e.id} onClick={() => setOpen(open === e.id ? null : e.id)}>{open === e.id ? 'Hide details' : 'Details'}</button>
                            {e.status !== 'acknowledged' && e.status !== 'resolved' ? <button className="btn" type="button" disabled={busy === e.id} onClick={() => mark(e.id, 'acknowledged')}>Acknowledge</button> : null}
                            {e.status !== 'resolved' ? <button className="btn" type="button" disabled={busy === e.id} onClick={() => mark(e.id, 'resolved')}>Resolve</button> : <button className="btn" type="button" disabled={busy === e.id} onClick={() => mark(e.id, 'open')}>Reopen</button>}
                        </div>
                        {open === e.id ? (
                            <div className="stack small" style={{ gap: 6 }}>
                                <span><strong>Why:</strong> {e.reason}</span>
                                {e.target_ids?.length ? <span><strong>Affected IDs:</strong> {e.target_ids.join(', ')}</span> : null}
                                {e.evidence?.permissions?.length ? <span><strong>Permissions:</strong> {e.evidence.permissions.join(', ')}</span> : null}
                                {e.containment_actions?.length ? (
                                    <span><strong>Actions taken:</strong> {e.containment_actions.map((a, i) => (
                                        <span key={i} style={{ display: 'block' }}>{a.action === 'remove_roles' ? `Remove roles ${(a.roleIds || []).join(', ')} from ${a.targetId}` : `Kick bot ${a.targetId}`}: {a.result}{a.error ? ` (${a.error})` : ''}</span>
                                    ))}</span>
                                ) : <span><strong>Actions taken:</strong> none</span>}
                            </div>
                        ) : null}
                    </div>
                ))}
            </div>
            {state.next ? <button className="btn" type="button" disabled={state.loading} onClick={() => load(state.next)}>{state.loading ? 'Loading…' : 'Load more'}</button> : null}
            {state.loading && state.events.length === 0 ? <p className="help">Loading incidents…</p> : null}
        </div>
    );
}

export default function AntiNukeTab({ guildId, channels, roles, inviteUrl, toast }) {
    const [state, setState] = useState({ loading: true, data: null, error: null });
    const [draft, setDraft] = useState(null);
    const [trustedText, setTrustedText] = useState('');
    const [maintenanceHours, setMaintenanceHours] = useState(0);
    const [errors, setErrors] = useState({});
    const [busy, setBusy] = useState(false);

    const apply = useCallback((data) => {
        setState({ loading: false, data, error: null });
        setDraft(data.settings);
        setTrustedText(data.settings.trusted_user_ids.join('\n'));
        setMaintenanceHours(0);
    }, []);

    useEffect(() => {
        request(`/api/guilds/${guildId}/antinuke`).then(apply, (error) => setState({ loading: false, data: null, error: error.message }));
    }, [guildId, apply]);

    if (state.loading) return <div className="card"><p className="help" style={{ margin: 0 }}>Loading Anti-Nuke…</p></div>;
    if (state.error) return <div className="notice" role="alert">{state.error}</div>;

    const { meta } = state.data;
    const sendable = (channels || []).filter((c) => c.type === 0 || c.type === 5);
    const set = (key) => (value) => setDraft((d) => ({ ...d, [key]: value }));
    const setThreshold = (key, value) => setDraft((d) => ({ ...d, thresholds: { ...d.thresholds, [key]: value === '' ? '' : Number(value) } }));
    const setContainment = (key, value) => setDraft((d) => ({ ...d, containment: { ...d.containment, [key]: value } }));
    const maintenanceActive = Date.parse(draft.maintenance_until || '') > Date.now();

    async function save(event) {
        event.preventDefault();
        setBusy(true);
        setErrors({});
        const trusted = trustedText.split(/[\s,]+/).map((v) => v.trim()).filter(Boolean);
        const settings = {
            ...draft,
            trusted_user_ids: trusted,
            maintenance_until: maintenanceHours > 0 ? new Date(Date.now() + maintenanceHours * 3_600_000).toISOString() : (maintenanceActive ? draft.maintenance_until : null)
        };
        try {
            apply(await request(`/api/guilds/${guildId}/antinuke`, { method: 'PUT', body: { settings } }));
            toast('Anti-Nuke settings saved. ZiGBoT applies them within about a minute.');
        } catch (error) {
            setErrors(error.data?.fieldErrors || {});
            toast(error.message, 'err');
        } finally {
            setBusy(false);
        }
    }

    const err = (key) => (errors[key] ? <span className="error" role="alert">{errors[key]}</span> : null);

    return (
        <div className="stack">
            <Overview data={state.data} inviteUrl={inviteUrl} />

            <form className="stack" onSubmit={save} aria-label="Anti-Nuke settings">
                <div className="card stack">
                    <h2 style={{ margin: 0 }}>Alerts</h2>
                    <div className="grid-2">
                        <label className="field" htmlFor="an-channel">
                            <span className="label">Security alert channel</span>
                            <span className="help">Pick a private channel only admins can see. ZiGBoT creates a private #zigbot-security channel when it joins a server, if it is allowed to.</span>
                            <select id="an-channel" value={draft.alert_channel_id || ''} onChange={(e) => set('alert_channel_id')(e.target.value || null)} aria-invalid={errors.alert_channel_id ? 'true' : undefined}>
                                <option value="">#zigbot-security if it exists, otherwise DM the owner</option>
                                {sendable.map((c) => <option key={c.id} value={c.id}>#{c.name}</option>)}
                            </select>
                            {err('alert_channel_id')}
                        </label>
                        <label className="field" htmlFor="an-staff">
                            <span className="label">Staff role to ping</span>
                            <span className="help">Pinged on HIGH and CRITICAL alerts. Optional.</span>
                            <select id="an-staff" value={draft.staff_role_id || ''} onChange={(e) => set('staff_role_id')(e.target.value || null)} aria-invalid={errors.staff_role_id ? 'true' : undefined}>
                                <option value="">No staff ping</option>
                                {(roles || []).map((r) => <option key={r.id} value={r.id}>@{r.name}</option>)}
                            </select>
                            {err('staff_role_id')}
                        </label>
                    </div>
                    <label className="switch" htmlFor="an-owner">
                        <input id="an-owner" type="checkbox" checked={draft.notify_owner} onChange={(e) => set('notify_owner')(e.target.checked)} />
                        <span className="track" aria-hidden="true" />
                        <span><span className="label" style={{ display: 'block' }}>Mention the server owner</span><span className="help">The owner is pinged on every alert, and gets a DM when no alert channel works.</span></span>
                    </label>
                    <label className="switch" htmlFor="an-everyone">
                        <input id="an-everyone" type="checkbox" checked={draft.everyone_on_critical} onChange={(e) => set('everyone_on_critical')(e.target.checked)} />
                        <span className="track" aria-hidden="true" />
                        <span><span className="label" style={{ display: 'block' }}>@everyone on CRITICAL incidents</span><span className="help">Only CRITICAL incidents (mass deletion, mass bans), and only members who can see the alert channel are pinged. Off by default.</span></span>
                    </label>
                    <label className="field" htmlFor="an-cooldown" style={{ maxWidth: 260 }}>
                        <span className="label">Alert cooldown (minutes)</span>
                        <span className="help">The same incident from the same account alerts once per cooldown, unless it gets more severe.</span>
                        <input id="an-cooldown" type="number" min={meta.limits.cooldownMin} max={meta.limits.cooldownMax} value={draft.cooldown_minutes} onChange={(e) => set('cooldown_minutes')(e.target.value === '' ? '' : Number(e.target.value))} aria-invalid={errors.cooldown_minutes ? 'true' : undefined} />
                        {err('cooldown_minutes')}
                    </label>
                </div>

                <div className="card stack">
                    <h2 style={{ margin: 0 }}>Detection thresholds</h2>
                    <p className="help" style={{ margin: 0 }}>Counts per account inside the detection window (joins: for the whole server). One deletion or ban never alerts on its own.</p>
                    <div className="grid-2">
                        {Object.entries(meta.thresholds).map(([key, limit]) => (
                            <label key={key} className="field" htmlFor={`an-th-${key}`}>
                                <span className="label">{limit.label}</span>
                                <input id={`an-th-${key}`} type="number" min={limit.min} max={limit.max} value={draft.thresholds[key]} onChange={(e) => setThreshold(key, e.target.value)} aria-invalid={errors[`thresholds.${key}`] ? 'true' : undefined} />
                                <span className="help">{limit.min}–{limit.max}, default {limit.default}</span>
                                {err(`thresholds.${key}`)}
                            </label>
                        ))}
                    </div>
                </div>

                <div className="card stack">
                    <h2 style={{ margin: 0 }}>Trusted accounts & maintenance</h2>
                    <label className="field" htmlFor="an-trusted">
                        <span className="label">Trusted accounts (Discord user IDs)</span>
                        <span className="help">One per line, up to {meta.limits.trustedUsers}. Trusted admins can do normal maintenance without HIGH/MEDIUM alerts. A burst three times the CRITICAL threshold still alerts, because trusted accounts can be hacked too. The owner is treated the same way.</span>
                        <textarea id="an-trusted" rows={4} value={trustedText} onChange={(e) => setTrustedText(e.target.value)} aria-invalid={errors.trusted_user_ids ? 'true' : undefined} />
                        {err('trusted_user_ids')}
                    </label>
                    <label className="field" htmlFor="an-maint" style={{ maxWidth: 360 }}>
                        <span className="label">Maintenance mode</span>
                        <span className="help">{maintenanceActive ? `On until ${when(draft.maintenance_until)}. ` : ''}While on, everyone is treated as trusted (extreme bursts still alert). Use it for a planned server rebuild.</span>
                        <select id="an-maint" value={maintenanceHours} onChange={(e) => setMaintenanceHours(Number(e.target.value))}>
                            {MAINTENANCE_CHOICES.map((h) => <option key={h} value={h}>{h === 0 ? (maintenanceActive ? 'Keep the current window' : 'Off') : `On for ${h} hour${h > 1 ? 's' : ''}`}</option>)}
                        </select>
                        {maintenanceActive ? <button className="btn" type="button" onClick={() => { set('maintenance_until')(null); setMaintenanceHours(0); }}>End maintenance now</button> : null}
                        {err('maintenance_until')}
                    </label>
                </div>

                <div className="card stack">
                    <h2 style={{ margin: 0 }}>Optional automatic containment</h2>
                    <p className="help" style={{ margin: 0 }}>Off by default. ZiGBoT never bans, never acts on the server owner or anyone above its own role, and only reports an action as done after Discord confirms it.</p>
                    {Object.entries(meta.containment).map(([key, option]) => (
                        <label key={key} className="switch" htmlFor={`an-c-${key}`}>
                            <input id={`an-c-${key}`} type="checkbox" checked={draft.containment[key]} onChange={(e) => setContainment(key, e.target.checked)} />
                            <span className="track" aria-hidden="true" />
                            <span><span className="label" style={{ display: 'block' }}>{option.label}</span><span className="help">{option.help} Needs ZiGBoT&apos;s <strong>{option.permission}</strong> permission.</span></span>
                        </label>
                    ))}
                </div>

                <div className="row">
                    <button className="btn btn-primary" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save Anti-Nuke settings'}</button>
                    <span className="help">Monitoring stays on whatever you save here.</span>
                </div>
            </form>

            <Incidents guildId={guildId} toast={toast} />
        </div>
    );
}
