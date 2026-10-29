// Super Admin building blocks (server components: no browser JavaScript).

export function StatCard({ label, value, hint = null, unavailable = null }) {
    return (
        <div className="adm-card">
            <span className="adm-k">{label}</span>
            {value === null || value === undefined
                ? <span className="adm-v adm-unavailable" title={unavailable || 'Not available'}>—</span>
                : <span className="adm-v">{value}</span>}
            {value === null || value === undefined
                ? <span className="adm-h">{unavailable || 'Not available yet.'}</span>
                : hint ? <span className="adm-h">{hint}</span> : null}
        </div>
    );
}

const STATUS_CLASS = {
    active: 'is-active', captured: 'is-active', sent: 'is-active', reviewed: 'is-active', resolved: 'is-active', monitoring: 'is-active',
    pending: 'is-pending', authorized: 'is-pending', created: 'is-pending', authenticated: 'is-pending', new: 'is-pending', open: 'is-pending', acknowledged: 'is-pending',
    cancelled: 'is-expired', completed: 'is-expired', expired: 'is-expired', halted: 'is-suspended', paused: 'is-expired', archived: 'is-expired', refunded: 'is-expired',
    failed: 'is-critical', CRITICAL: 'is-critical', HIGH: 'is-pending', MEDIUM: 'is-expired', suspended: 'is-suspended'
};

/** A status chip: always the text label, plus a colour cue (never colour alone). */
export function Status({ value, label = null }) {
    if (!value) return <span className="adm-unavailable">—</span>;
    return <span className={`adm-status ${STATUS_CLASS[value] || ''}`}>{label || value}</span>;
}

export function When({ at }) {
    if (!at) return <span className="adm-unavailable">never</span>;
    const date = new Date(at);
    return <time dateTime={date.toISOString()} title={date.toISOString()}>{date.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' })}</time>;
}

/** Previous/next links that keep the current filters. */
export function Pager({ base, params = {}, page, total, pageSize }) {
    const pages = Math.max(1, Math.ceil(total / pageSize));
    const href = (p) => {
        const query = new URLSearchParams({ ...Object.fromEntries(Object.entries(params).filter(([, v]) => v)), page: String(p) });
        return `${base}?${query.toString()}`;
    };
    return (
        <nav className="adm-pager" aria-label="Pages">
            <span className="help">Page {page} of {pages} · {total} total</span>
            {page > 1 ? <a className="btn" href={href(page - 1)}>Previous</a> : <span className="btn" aria-disabled="true" style={{ opacity: 0.5 }}>Previous</span>}
            {page < pages ? <a className="btn" href={href(page + 1)}>Next</a> : <span className="btn" aria-disabled="true" style={{ opacity: 0.5 }}>Next</span>}
        </nav>
    );
}

export function Unavailable({ children }) {
    return <div className="notice"><span className="adm-unavailable">{children}</span></div>;
}

/**
 * Single-series bar chart (one hue, so no legend: the title names it).
 * Hover any bar for its exact value; "Show data" gives the same numbers as a table.
 */
export function BarChart({ title, data, format = (v) => String(v), unavailable = null, height = 160 }) {
    if (!data) {
        return (
            <section className="card adm-chart" aria-label={title}>
                <h3 style={{ margin: 0, fontSize: 15 }}>{title}</h3>
                <p className="adm-unavailable" style={{ margin: 0 }}>{unavailable || 'Not available.'}</p>
            </section>
        );
    }
    const width = 600;
    const top = 18;
    const bottom = 28;
    const plot = height - top - bottom;
    const max = Math.max(1, ...data.map((d) => d.value));
    const slot = width / data.length;
    const barWidth = Math.max(4, Math.min(28, slot - 8));
    const showEvery = data.length > 8 ? 2 : 1;
    const bar = (d, i) => {
        const h = d.value > 0 ? Math.max(2, (d.value / max) * plot) : 0;
        const x = i * slot + (slot - barWidth) / 2;
        const y = top + plot - h;
        const r = Math.min(4, h, barWidth / 2);
        // Rounded data-end on top, square on the baseline.
        const path = h > 0 ? `M${x},${top + plot} V${y + r} Q${x},${y} ${x + r},${y} H${x + barWidth - r} Q${x + barWidth},${y} ${x + barWidth},${y + r} V${top + plot} Z` : '';
        return (
            <g key={d.key}>
                {/* Taller invisible hit target than the bar itself. */}
                <rect x={i * slot} y={top} width={slot} height={plot} fill="transparent"><title>{`${d.label}: ${format(d.value)}`}</title></rect>
                {path ? <path className="bar" d={path}><title>{`${d.label}: ${format(d.value)}`}</title></path> : null}
                {i % showEvery === 0 || i === data.length - 1 ? <text x={i * slot + slot / 2} y={height - 8} textAnchor="middle">{d.label.length > 9 ? d.label.slice(0, 3) : d.label}</text> : null}
            </g>
        );
    };
    const total = data.reduce((a, d) => a + d.value, 0);
    return (
        <section className="card adm-chart" aria-label={title}>
            <div className="spread">
                <h3 style={{ margin: 0, fontSize: 15 }}>{title}</h3>
                <span className="help">max {format(max === 1 && total === 0 ? 0 : max)}</span>
            </div>
            <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${title}. ${data.map((d) => `${d.label}: ${format(d.value)}`).join(', ')}`}>
                <line className="axis" x1="0" x2={width} y1={top + plot + 0.5} y2={top + plot + 0.5} />
                {data.map(bar)}
            </svg>
            <details>
                <summary>Show data</summary>
                <table className="adm-table">
                    <tbody>{data.map((d) => <tr key={d.key}><td>{d.label}</td><td className="num">{format(d.value)}</td></tr>)}</tbody>
                </table>
            </details>
        </section>
    );
}
