'use client';

import { useEffect, useState } from 'react';

// Analytics (Section L): daily counts as simple SVG bar charts, plus CSV
// export. Data comes from /api/guilds/[id]/analytics (admin-verified).
const SERIES = [
    { key: 'messages', label: 'Messages', color: '#a855f7' },
    { key: 'active', label: 'Active members', color: '#22d3ee' },
    { key: 'joins', label: 'Joins', color: '#22c55e' },
    { key: 'leaves', label: 'Leaves', color: '#f97316' }
];

function Bars({ rows, series }) {
    const max = Math.max(1, ...rows.map((r) => r[series.key]));
    const width = Math.max(rows.length * 14, 140);
    return (
        <figure style={{ margin: 0 }}>
            <figcaption className="label">{series.label} (max {max})</figcaption>
            <svg viewBox={`0 0 ${width} 80`} role="img" aria-label={`${series.label} per day`} style={{ width: '100%', height: 90 }} preserveAspectRatio="none">
                {rows.map((r, i) => {
                    const h = Math.round((r[series.key] / max) * 72);
                    return <rect key={r.day} x={i * 14 + 2} y={78 - h} width={10} height={Math.max(h, 1)} rx={2} fill={series.color}><title>{`${r.day}: ${r[series.key]}`}</title></rect>;
                })}
            </svg>
        </figure>
    );
}

export default function AnalyticsTab({ guildId, enabled }) {
    const [days, setDays] = useState(30);
    const [state, setState] = useState({ loading: true, rows: [], error: null });

    useEffect(() => {
        let alive = true;
        setState((s) => ({ ...s, loading: true, error: null }));
        fetch(`/api/guilds/${guildId}/analytics?days=${days}`, { cache: 'no-store' })
            .then(async (res) => {
                const body = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(body.error || 'Could not load analytics.');
                if (alive) setState({ loading: false, rows: body.rows || [], error: null });
            })
            .catch((error) => alive && setState({ loading: false, rows: [], error: error.message }));
        return () => { alive = false; };
    }, [guildId, days]);

    const totals = state.rows.reduce((t, r) => ({ joins: t.joins + r.joins, leaves: t.leaves + r.leaves, messages: t.messages + r.messages, moderation: t.moderation + r.moderation, security: t.security + r.security, tickets: t.tickets + r.tickets }), { joins: 0, leaves: 0, messages: 0, moderation: 0, security: 0, tickets: 0 });

    return (
        <div className="card">
            <h2>Analytics</h2>
            <p className="help">Daily counts only: no message content and no member ids are stored. {enabled ? '' : 'Collection is off: switch it on in Add-ons → Analytics, then save.'}</p>
            <div className="row" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'end', marginBottom: 12 }}>
                <label className="field" htmlFor="analytics-days" style={{ minWidth: 160 }}>
                    <span className="label">Period</span>
                    <select id="analytics-days" value={days} onChange={(e) => setDays(Number(e.target.value))}>
                        <option value={7}>Last 7 days</option>
                        <option value={30}>Last 30 days</option>
                        <option value={90}>Last 90 days</option>
                    </select>
                </label>
                <a className="btn" href={`/api/guilds/${guildId}/analytics?days=${days}&format=csv`} download>Export CSV</a>
            </div>
            {state.loading ? <p className="help" aria-live="polite">Loading…</p> : null}
            {state.error ? <p className="error" role="alert">{state.error}</p> : null}
            {!state.loading && !state.error && state.rows.length === 0 ? <p className="help">No data yet.</p> : null}
            {state.rows.length ? (
                <>
                    <p>
                        <strong>{totals.messages}</strong> messages · <strong>+{totals.joins}</strong> / <strong>−{totals.leaves}</strong> members ·{' '}
                        <strong>{totals.moderation}</strong> moderation cases · <strong>{totals.security}</strong> security incidents · <strong>{totals.tickets}</strong> tickets
                    </p>
                    <div className="grid" style={{ gap: 16 }}>
                        {SERIES.map((series) => <Bars key={series.key} rows={state.rows} series={series} />)}
                    </div>
                </>
            ) : null}
        </div>
    );
}
