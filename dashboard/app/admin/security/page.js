import { notFound } from 'next/navigation';
import { getSuperAdmin } from '@/lib/admin';
import { loadSecurity, PAGE_SIZE } from '@/lib/adminData';
import { Pager, Status, StatCard, When, Unavailable } from '@/components/admin/ui';
import IncidentStatus from '@/components/admin/IncidentStatus';

export const dynamic = 'force-dynamic';

const CONTAINMENT = { not_enabled: 'off', not_applicable: 'n/a', succeeded: 'contained (verified)', partial: 'partly contained', failed: 'containment failed', skipped: 'not possible' };

export default async function AdminSecurity({ searchParams }) {
    if (!(await getSuperAdmin())) notFound();
    const params = await searchParams;
    const severity = String(params?.severity || '');
    // Open incidents by default; "all" is explicit so it survives paging.
    const status = params?.status ? String(params.status) : 'open';
    const data = await loadSecurity({ severity, status, page: params?.page });
    const cov = data.coverage;
    return (
        <>
            <header className="adm-top"><h1>Security Center</h1><span className="help">Anti-Nuke across every server</span></header>
            {data.coverageError ? <Unavailable>{data.coverageError}</Unavailable> : (
                <div className="adm-cards">
                    <StatCard label="Servers reporting" value={String(cov.total)} />
                    <StatCard label="Monitoring (fresh)" value={String(cov.monitoring)} hint="Reported in the last 30 minutes with View Audit Log" />
                    <StatCard label="Servers with gaps" value={String(cov.gaps.length)} hint="Missing permissions, no alert channel, or stale" />
                </div>
            )}
            {cov && cov.gaps.length ? (
                <details className="card" style={{ marginBottom: 16 }}>
                    <summary><strong>Servers with protection gaps ({cov.gaps.length})</strong></summary>
                    <div className="adm-table-wrap" style={{ marginTop: 12 }}>
                        <table className="adm-table">
                            <thead><tr><th>Server</th><th>Monitoring</th><th>Missing permissions</th><th>Alert channel</th><th>Last report</th></tr></thead>
                            <tbody>{cov.gaps.map((g) => (
                                <tr key={g.guild_id}>
                                    <td><a href={`/admin/servers/${g.guild_id}`}>{g.guild_name}</a></td>
                                    <td>{g.stale ? <Status value="pending" label="stale" /> : g.monitoring ? <Status value="active" label="yes" /> : <Status value="failed" label="no" />}</td>
                                    <td>{(g.missing_permissions || []).join(', ') || 'none'}</td>
                                    <td>{g.alert_channel_ok ? 'OK' : 'cannot post (owner DM)'}</td>
                                    <td><When at={g.last_checked_at} /></td>
                                </tr>
                            ))}</tbody>
                        </table>
                    </div>
                </details>
            ) : null}

            <form className="adm-filters" method="get" aria-label="Filter incidents">
                <label className="field"><span className="help">Severity</span>
                    <select name="severity" defaultValue={severity}><option value="">All</option><option>CRITICAL</option><option>HIGH</option><option>MEDIUM</option></select>
                </label>
                <label className="field"><span className="help">Status</span>
                    <select name="status" defaultValue={status}><option value="all">All</option><option value="open">Open</option><option value="acknowledged">Acknowledged</option><option value="resolved">Resolved</option></select>
                </label>
                <button className="btn" type="submit">Apply</button>
            </form>
            {data.error ? <div className="notice" role="alert">{data.error}</div> : null}
            {data.events.length === 0 && !data.error ? <div className="empty"><p className="muted" style={{ margin: 0 }}>No incidents match. 🛡️</p></div> : null}
            <div className="stack">
                {data.events.map((e) => (
                    <details key={e.id} className="card">
                        <summary className="spread" style={{ cursor: 'pointer' }}>
                            <span><Status value={e.severity} /> <strong>{e.title}</strong> <span className="help">in {e.guild_name}{e.occurrences > 1 ? ` · ×${e.occurrences}` : ''}</span></span>
                            <span className="help"><When at={e.created_at} /> · {e.status}</span>
                        </summary>
                        <div className="stack" style={{ marginTop: 12 }}>
                            <dl className="adm-dl">
                                <dt>Server</dt><dd><a href={`/admin/servers/${e.guild_id}`}><code>{e.guild_id}</code></a></dd>
                                <dt>Suspected actor</dt><dd>{e.actor_id ? <><code>{e.actor_id}</code>{e.actor_is_bot ? ' (bot)' : ''}</> : 'not identified'}</dd>
                                <dt>Why it was flagged</dt><dd>{e.reason}</dd>
                                <dt>Containment</dt><dd>{CONTAINMENT[e.containment_status] || e.containment_status}{(e.containment_actions || []).map((a, i) => <div key={i} className="help">{a.action}: {a.result}{a.error ? ` (${a.error})` : ''}</div>)}</dd>
                                <dt>Alert</dt><dd>{e.alert_status}</dd>
                                <dt>Status</dt><dd><IncidentStatus id={e.id} status={e.status} /></dd>
                            </dl>
                            <div>
                                <strong>Recommended steps</strong>
                                <ol className="small">{e.steps.map((s) => <li key={s}>{s}</li>)}</ol>
                            </div>
                        </div>
                    </details>
                ))}
            </div>
            <Pager base="/admin/security" params={{ severity, status }} page={data.page} total={data.total} pageSize={PAGE_SIZE} />
        </>
    );
}
