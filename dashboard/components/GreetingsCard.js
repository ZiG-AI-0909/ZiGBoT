'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import greetings from '@/lib/shared/greetings';

// Scheduled greetings (Roles tab). Every control talks to the real API;
// the bot sends the greetings itself, so they keep running with this page
// closed. The preview uses the same placeholder code as the bot.

const { renderGreeting, timeZones, GREETING_WEEKDAYS, describeSchedule } = greetings;
const TYPE_LABELS = { once: 'Once', daily: 'Daily', weekly: 'Weekly', interval: 'Custom interval' };
const STATUS_LABELS = {
    sending: 'Sending…',
    sent: 'Sent',
    missed: 'Skipped (ZiGBoT was offline at that time)',
    failed: 'Failed (Discord error)',
    channel_missing: 'Channel deleted: paused',
    no_permission: 'ZiGBoT may not post in that channel',
    bot_not_in_server: 'ZiGBoT is not in this server: paused',
    completed: 'Completed'
};

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

const browserZone = () => {
    try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    } catch {
        return 'UTC';
    }
};

// Tomorrow 09:00 as a local "YYYY-MM-DDTHH:MM" value for <input type="datetime-local">.
function tomorrowNine() {
    const d = new Date(Date.now() + 86_400_000);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T09:00`;
}

function blankDraft(channels) {
    return {
        channel_id: channels.find((c) => c.canSend)?.id || '',
        message: 'Good morning, {server}! ☀️ Hope everyone has a great day.',
        schedule_type: 'daily',
        start_local: tomorrowNine(),
        time_zone: browserZone(),
        weekdays: [1, 2, 3, 4, 5],
        interval_hours: 24,
        end_date: '',
        enabled: true
    };
}

function draftOf(schedule) {
    return {
        channel_id: schedule.channel_id,
        message: schedule.message,
        schedule_type: schedule.schedule_type,
        start_local: schedule.start_local,
        time_zone: schedule.time_zone,
        weekdays: schedule.weekdays?.length ? schedule.weekdays : [1, 2, 3, 4, 5],
        interval_hours: schedule.interval_minutes ? schedule.interval_minutes / 60 : 24,
        end_date: schedule.end_date || '',
        enabled: schedule.enabled
    };
}

function toPayload(draft) {
    return {
        channel_id: draft.channel_id,
        message: draft.message,
        schedule_type: draft.schedule_type,
        start_local: draft.start_local,
        time_zone: draft.time_zone,
        weekdays: draft.schedule_type === 'weekly' ? draft.weekdays : [],
        interval_minutes: draft.schedule_type === 'interval' ? Math.round(Number(draft.interval_hours) * 60) : null,
        end_date: draft.schedule_type === 'once' ? null : draft.end_date || null,
        enabled: draft.enabled
    };
}

function zoned(iso, timeZone) {
    if (!iso) return null;
    try {
        return new Date(iso).toLocaleString(undefined, { timeZone, dateStyle: 'medium', timeStyle: 'short' });
    } catch {
        return new Date(iso).toLocaleString();
    }
}

function Editor({ draft, setDraft, channels, meta, errors, busy, onSave, onCancel, isNew }) {
    const zones = useMemo(() => timeZones(), []);
    const set = (key) => (value) => setDraft((d) => ({ ...d, [key]: value }));
    const preview = renderGreeting(draft.message, { serverName: meta.serverName, timeZone: draft.time_zone, now: Date.now() });
    const err = (key) => (errors[key] ? <span className="error" role="alert">{errors[key]}</span> : null);
    const toggleDay = (day) => setDraft((d) => ({ ...d, weekdays: d.weekdays.includes(day) ? d.weekdays.filter((x) => x !== day) : [...d.weekdays, day].sort() }));
    return (
        <form className="stack" onSubmit={onSave} aria-label={isNew ? 'New scheduled greeting' : 'Edit scheduled greeting'}>
            <div className="grid-2">
                <label className="field" htmlFor="gr-channel">
                    <span className="label">Channel</span>
                    <select id="gr-channel" value={draft.channel_id} onChange={(e) => set('channel_id')(e.target.value)} aria-invalid={errors.channel_id ? 'true' : undefined}>
                        <option value="" disabled>Pick a channel</option>
                        {channels.map((c) => <option key={c.id} value={c.id} disabled={!c.canSend}>#{c.name}{c.canSend ? '' : ' (ZiGBoT cannot post here)'}</option>)}
                    </select>
                    {err('channel_id')}
                </label>
                <label className="field" htmlFor="gr-tz">
                    <span className="label">Time zone</span>
                    <select id="gr-tz" value={draft.time_zone} onChange={(e) => set('time_zone')(e.target.value)} aria-invalid={errors.time_zone ? 'true' : undefined}>
                        {!zones.includes(draft.time_zone) ? <option value={draft.time_zone}>{draft.time_zone}</option> : null}
                        {zones.map((z) => <option key={z} value={z}>{z}</option>)}
                    </select>
                    {err('time_zone')}
                </label>
            </div>

            <label className="field" htmlFor="gr-message">
                <span className="label">Greeting message</span>
                <span className="help">Discord formatting works. Placeholders: {meta.placeholders.map((p) => <code key={p.token} title={p.description} style={{ marginRight: 6 }}>{p.token}</code>)}. Greetings never ping anyone.</span>
                <textarea id="gr-message" rows={4} maxLength={meta.limits.messageMax} value={draft.message} onChange={(e) => set('message')(e.target.value)} aria-invalid={errors.message ? 'true' : undefined} />
                <span className="help">{draft.message.length}/{meta.limits.messageMax}</span>
                {err('message')}
            </label>

            <div className="field">
                <span className="label" id="gr-type-label">Repeat</span>
                <div className="segmented" role="group" aria-labelledby="gr-type-label">
                    {meta.types.map((t) => <button type="button" key={t} aria-pressed={draft.schedule_type === t} onClick={() => set('schedule_type')(t)}>{TYPE_LABELS[t]}</button>)}
                </div>
                {err('schedule_type')}
            </div>

            <div className="grid-2">
                <label className="field" htmlFor="gr-start">
                    <span className="label">{draft.schedule_type === 'once' ? 'Send on' : 'Start date and time'}</span>
                    <span className="help">{draft.schedule_type === 'daily' || draft.schedule_type === 'weekly' ? 'Repeats at this time of day, in the time zone above.' : 'In the time zone above.'}</span>
                    <input id="gr-start" type="datetime-local" value={draft.start_local} onChange={(e) => set('start_local')(e.target.value.slice(0, 16))} aria-invalid={errors.start_local ? 'true' : undefined} />
                    {err('start_local')}
                </label>
                {draft.schedule_type !== 'once' ? (
                    <label className="field" htmlFor="gr-end">
                        <span className="label">End date (optional)</span>
                        <span className="help">The last day greetings are sent. Empty = until you pause or delete it.</span>
                        <input id="gr-end" type="date" value={draft.end_date} onChange={(e) => set('end_date')(e.target.value)} aria-invalid={errors.end_date ? 'true' : undefined} />
                        {err('end_date')}
                    </label>
                ) : null}
            </div>

            {draft.schedule_type === 'weekly' ? (
                <div className="field">
                    <span className="label" id="gr-days-label">Weekdays</span>
                    <div className="segmented" role="group" aria-labelledby="gr-days-label">
                        {GREETING_WEEKDAYS.map((name, day) => <button type="button" key={name} aria-pressed={draft.weekdays.includes(day)} onClick={() => toggleDay(day)}>{name}</button>)}
                    </div>
                    {err('weekdays')}
                </div>
            ) : null}
            {draft.schedule_type === 'interval' ? (
                <label className="field" htmlFor="gr-interval" style={{ maxWidth: 260 }}>
                    <span className="label">Every (hours)</span>
                    <span className="help">At least every {meta.limits.intervalMinMinutes / 60} hour, so it never spams.</span>
                    <input id="gr-interval" type="number" min={meta.limits.intervalMinMinutes / 60} max={meta.limits.intervalMaxMinutes / 60} step="1" value={draft.interval_hours} onChange={(e) => set('interval_hours')(e.target.value)} aria-invalid={errors.interval_minutes ? 'true' : undefined} />
                    {err('interval_minutes')}
                </label>
            ) : null}

            <label className="switch" htmlFor="gr-enabled">
                <input id="gr-enabled" type="checkbox" checked={draft.enabled} onChange={(e) => set('enabled')(e.target.checked)} />
                <span className="track" aria-hidden="true" />
                <span><span className="label" style={{ display: 'block' }}>Enable Greeting Alarm</span><span className="help">On: ZiGBoT keeps sending on this schedule until you pause or delete it.</span></span>
            </label>

            <div className="field">
                <span className="label">Preview</span>
                <div className="card" style={{ whiteSpace: 'pre-wrap', margin: 0 }} aria-live="polite">{preview || <span className="muted">Your greeting will appear here.</span>}</div>
                <span className="help">{describeSchedule(toPayload(draft))}</span>
            </div>

            <div className="row">
                <button className="btn btn-primary" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save Schedule'}</button>
                <button className="btn" type="button" onClick={onCancel} disabled={busy}>Cancel</button>
            </div>
        </form>
    );
}

export default function GreetingsCard({ guildId, toast }) {
    const [state, setState] = useState({ loading: true, error: null, schedules: [], channels: [], meta: null });
    const [editing, setEditing] = useState(null); // null | 'new' | schedule id
    const [draft, setDraft] = useState(null);
    const [errors, setErrors] = useState({});
    const [busy, setBusy] = useState(null);
    const [confirmDelete, setConfirmDelete] = useState(null);

    const load = useCallback(async () => {
        try {
            const data = await request(`/api/guilds/${guildId}/greetings`);
            setState({ loading: false, error: null, schedules: data.schedules, channels: data.channels, meta: data.meta });
        } catch (error) {
            setState((s) => ({ ...s, loading: false, error: error.message }));
        }
    }, [guildId]);

    useEffect(() => {
        load();
    }, [load]);

    const channelName = (id) => state.channels.find((c) => c.id === id)?.name || 'deleted channel';
    const replace = (schedule) => setState((s) => ({ ...s, schedules: s.schedules.some((x) => x.id === schedule.id) ? s.schedules.map((x) => (x.id === schedule.id ? schedule : x)) : [...s.schedules, schedule] }));

    function open(target) {
        setErrors({});
        setEditing(target === 'new' ? 'new' : target.id);
        setDraft(target === 'new' ? blankDraft(state.channels) : draftOf(target));
    }

    async function save(event) {
        event.preventDefault();
        setBusy('save');
        setErrors({});
        try {
            const isNew = editing === 'new';
            const data = await request(isNew ? `/api/guilds/${guildId}/greetings` : `/api/guilds/${guildId}/greetings/${editing}`, { method: isNew ? 'POST' : 'PATCH', body: { schedule: toPayload(draft) } });
            replace(data.schedule);
            setEditing(null);
            toast(data.schedule.enabled ? `Saved. Next greeting: ${zoned(data.schedule.next_run_at, data.schedule.time_zone)}.` : 'Saved (paused).');
        } catch (error) {
            setErrors(error.data?.fieldErrors || {});
            toast(error.message, 'err');
        } finally {
            setBusy(null);
        }
    }

    async function act(schedule, action) {
        setBusy(`${action}:${schedule.id}`);
        try {
            if (action === 'test') {
                await request(`/api/guilds/${guildId}/greetings/${schedule.id}/send-test`, { method: 'POST' });
                toast(`Test greeting sent to #${channelName(schedule.channel_id)}.`);
            } else if (action === 'delete') {
                await request(`/api/guilds/${guildId}/greetings/${schedule.id}`, { method: 'DELETE' });
                setState((s) => ({ ...s, schedules: s.schedules.filter((x) => x.id !== schedule.id) }));
                setConfirmDelete(null);
                toast('Scheduled greeting deleted. It will not be sent again.');
            } else {
                const data = await request(`/api/guilds/${guildId}/greetings/${schedule.id}`, { method: 'PATCH', body: { enabled: action === 'resume' } });
                replace(data.schedule);
                toast(action === 'resume' ? `Resumed. Next greeting: ${zoned(data.schedule.next_run_at, data.schedule.time_zone)}.` : 'Paused. No greetings are sent until you resume.');
            }
        } catch (error) {
            toast(error.message, 'err');
        } finally {
            setBusy(null);
        }
    }

    if (state.loading) return <div className="card"><p className="help" style={{ margin: 0 }}>Loading scheduled greetings…</p></div>;

    const atLimit = state.meta && state.schedules.length >= state.meta.limits.perGuild;
    return (
        <div className="card stack" aria-labelledby="greetings-title">
            <div className="spread">
                <div>
                    <h2 id="greetings-title" style={{ margin: 0 }}>⏰ Scheduled Greeting</h2>
                    <p className="help" style={{ margin: 0 }}>Schedule recurring greetings for your server. ZiGBoT sends them itself, even with this page closed.</p>
                </div>
                {state.meta && editing === null ? <button className="btn btn-primary" type="button" disabled={atLimit} onClick={() => open('new')}>{atLimit ? `Limit of ${state.meta.limits.perGuild} reached` : 'Configure new greeting'}</button> : null}
            </div>
            {state.error ? <div className="notice" role="alert">{state.error}</div> : null}

            {editing === 'new' && draft ? <Editor draft={draft} setDraft={setDraft} channels={state.channels} meta={state.meta} errors={errors} busy={busy === 'save'} onSave={save} onCancel={() => setEditing(null)} isNew /> : null}

            {!state.error && state.schedules.length === 0 && editing !== 'new' ? (
                <div className="empty"><p className="muted" style={{ margin: 0 }}>No scheduled greetings yet. Configure one to greet your server every morning, every Friday, or once for an event.</p></div>
            ) : null}

            {state.schedules.map((s) => (
                <div key={s.id} className="card stack" style={{ margin: 0 }}>
                    {editing === s.id && draft ? (
                        <Editor draft={draft} setDraft={setDraft} channels={state.channels} meta={state.meta} errors={errors} busy={busy === 'save'} onSave={save} onCancel={() => setEditing(null)} />
                    ) : (
                        <>
                            <div className="spread">
                                <span><span className={`pill ${s.enabled ? 'pill-ok' : 'pill-warn'}`}>{s.enabled ? 'Active' : 'Paused'}</span> <strong>#{channelName(s.channel_id)}</strong></span>
                                <span className="help">{s.description}</span>
                            </div>
                            <p className="small" style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{s.message.length > 220 ? `${s.message.slice(0, 220)}…` : s.message}</p>
                            <div className="grid-2 small">
                                <span><span className="help">Next greeting: </span>{s.enabled && s.next_run_at ? zoned(s.next_run_at, s.time_zone) : '—'}</span>
                                <span><span className="help">Last sent: </span>{s.last_sent_at ? zoned(s.last_sent_at, s.time_zone) : 'never'}</span>
                                <span><span className="help">Last result: </span>{s.last_status ? STATUS_LABELS[s.last_status] || s.last_status : '—'}{s.last_error ? ` (${s.last_error})` : ''}</span>
                                {s.recent_runs?.length ? <span><span className="help">Recent: </span>{s.recent_runs.map((r) => `${zoned(r.at, s.time_zone)} · ${STATUS_LABELS[r.status] || r.status}`).join(' | ')}</span> : null}
                            </div>
                            {confirmDelete === s.id ? (
                                <div className="notice row" role="alertdialog" aria-label="Confirm delete">
                                    <span>Delete this scheduled greeting? It will never be sent again.</span>
                                    <button className="btn btn-danger" type="button" disabled={Boolean(busy)} onClick={() => act(s, 'delete')}>{busy === `delete:${s.id}` ? 'Deleting…' : 'Yes, delete'}</button>
                                    <button className="btn" type="button" onClick={() => setConfirmDelete(null)}>Keep it</button>
                                </div>
                            ) : (
                                <div className="row">
                                    <button className="btn" type="button" onClick={() => open(s)} disabled={editing !== null}>Configure</button>
                                    <button className="btn" type="button" onClick={() => act(s, 'test')} disabled={Boolean(busy)}>{busy === `test:${s.id}` ? 'Sending…' : 'Test Greeting'}</button>
                                    <button className="btn" type="button" onClick={() => act(s, s.enabled ? 'pause' : 'resume')} disabled={Boolean(busy)}>{s.enabled ? 'Pause' : 'Resume'}</button>
                                    <button className="btn btn-danger" type="button" onClick={() => setConfirmDelete(s.id)} disabled={Boolean(busy)}>Delete</button>
                                </div>
                            )}
                        </>
                    )}
                </div>
            ))}
        </div>
    );
}
