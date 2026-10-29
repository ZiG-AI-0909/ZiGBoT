import { notFound } from 'next/navigation';
import { getSuperAdmin } from '@/lib/admin';
import { loadServerDetail } from '@/lib/adminData';
import { Status, When, Unavailable } from '@/components/admin/ui';

export const dynamic = 'force-dynamic';

export default async function AdminServer({ params }) {
    if (!(await getSuperAdmin())) notFound();
    const { guildId } = await params;
    const data = await loadServerDetail(guildId);
    if (!data) notFound();
    const { guild, live, subscription, security, settings, incidents } = data;
    const installed = guild.bot_installed && !guild.removed_at;
    return (
        <>
            <header className="adm-top"><h1>{guild.name || guild.guild_id}</h1><a className="btn" href="/admin/servers">All servers</a></header>
            {!installed ? <div className="notice">ZiGBoT is not in this server any more, so it cannot act here. The stored history below is kept until its retention ends.</div> : null}
            <div className="adm-grid">
                <section className="card stack">
                    <h2 style={{ margin: 0 }}>Server</h2>
                    <dl className="adm-dl">
                        <dt>Server ID</dt><dd><code>{guild.guild_id}</code></dd>
                        <dt>Owner</dt><dd>{guild.owner_discord_id ? <code>{guild.owner_discord_id}</code> : 'unknown'}</dd>
                        <dt>ZiGBoT</dt><dd>{installed ? <Status value="active" label="installed" /> : <Status value="expired" label="removed" />} <span className="help">since <When at={installed ? guild.installed_at : guild.removed_at} /></span></dd>
                        <dt>Members</dt><dd>{live?.members !== null && live?.members !== undefined ? `${live.members.toLocaleString('en-IN')} (approx., from Discord)` : <span className="adm-unavailable">unavailable{installed ? ' (Discord did not answer)' : ''}</span>}</dd>
                    </dl>
                </section>
                <section className="card stack">
                    <h2 style={{ margin: 0 }}>Premium</h2>
                    {subscription ? (
                        <dl className="adm-dl">
                            <dt>Status</dt><dd><Status value={subscription.active ? 'active' : subscription.status} label={subscription.status} /></dd>
                            <dt>Plan</dt><dd>{subscription.plan_period}</dd>
                            <dt>Period ends</dt><dd><When at={subscription.current_period_end} />{subscription.cancel_at_period_end ? ' · cancels at period end' : ''}</dd>
                            <dt>Subscription</dt><dd><code>{subscription.subscription_id}</code></dd>
                        </dl>
                    ) : <p className="help" style={{ margin: 0 }}>Free (no subscription on record).</p>}
                </section>
                <section className="card stack">
                    <h2 style={{ margin: 0 }}>Anti-Nuke</h2>
                    {security ? (
                        <dl className="adm-dl">
                            <dt>Monitoring</dt><dd>{security.monitoring ? <Status value="active" label="active" /> : <Status value="failed" label="not monitoring" />}</dd>
                            <dt>Missing permissions</dt><dd>{(security.missing_permissions || []).length ? security.missing_permissions.join(', ') : 'none'}</dd>
                            <dt>Alert channel</dt><dd>{settings?.alert_channel_id ? <code>{settings.alert_channel_id}</code> : 'not set (owner DM)'} · {security.alert_channel_ok ? 'ZiGBoT can post' : 'ZiGBoT cannot post'}</dd>
                            <dt>Containment</dt><dd>{settings?.containment && Object.entries(settings.containment).filter(([, on]) => on).map(([k]) => k.replace(/_/g, ' ')).join(', ') || 'off'}</dd>
                            <dt>Last report</dt><dd><When at={security.last_checked_at} /></dd>
                        </dl>
                    ) : <p className="help" style={{ margin: 0 }}>The bot has not reported Anti-Nuke status for this server.</p>}
                </section>
            </div>
            <h2>Recent security incidents</h2>
            {data.incidentsError ? <Unavailable>{data.incidentsError}</Unavailable> : incidents.length === 0 ? <p className="help">None recorded.</p> : (
                <div className="adm-table-wrap">
                    <table className="adm-table">
                        <thead><tr><th>When</th><th>Severity</th><th>Incident</th><th>Actor</th><th>Containment</th><th>Status</th></tr></thead>
                        <tbody>{incidents.map((e) => (
                            <tr key={e.id}>
                                <td><When at={e.created_at} /></td>
                                <td><Status value={e.severity} /></td>
                                <td>{e.title}{e.resource_count ? <span className="help"> · {e.resource_count}</span> : null}</td>
                                <td>{e.actor_id ? <code>{e.actor_id}</code> : <span className="help">unknown</span>}</td>
                                <td>{e.containment_status.replace('_', ' ')}</td>
                                <td><Status value={e.status} /></td>
                            </tr>
                        ))}</tbody>
                    </table>
                </div>
            )}
        </>
    );
}
