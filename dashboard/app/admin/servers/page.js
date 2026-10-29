import { notFound } from 'next/navigation';
import { getSuperAdmin } from '@/lib/admin';
import { loadServers, PAGE_SIZE } from '@/lib/adminData';
import { Pager, Status, When } from '@/components/admin/ui';

export const dynamic = 'force-dynamic';

function protection(security) {
    if (!security) return <span className="help">no report</span>;
    if (!security.monitoring) return <Status value="failed" label="not monitoring" />;
    if ((security.missing_permissions || []).length || !security.alert_channel_ok) return <Status value="pending" label="gaps" />;
    return <Status value="active" label="protected" />;
}

export default async function AdminServers({ searchParams }) {
    if (!(await getSuperAdmin())) notFound();
    const params = await searchParams;
    const q = String(params?.q || '');
    const data = await loadServers({ q, page: params?.page });
    return (
        <>
            <header className="adm-top"><h1>Servers</h1><span className="help">Every server ZiGBoT has been added to</span></header>
            <form className="adm-filters" method="get">
                <label className="field" style={{ flex: 1, minWidth: 220 }}>
                    <span className="help">Search by server name or ID</span>
                    <input name="q" defaultValue={q} />
                </label>
                <button className="btn" type="submit">Search</button>
            </form>
            {data.error ? <div className="notice" role="alert">{data.error}</div> : null}
            <div className="adm-table-wrap">
                <table className="adm-table">
                    <thead><tr><th>Server</th><th>Owner</th><th>ZiGBoT</th><th>Premium</th><th>Anti-Nuke</th><th>Open incidents</th><th /></tr></thead>
                    <tbody>
                        {data.servers.length === 0 ? <tr><td colSpan={7} className="help">No servers match.</td></tr> : data.servers.map((g) => (
                            <tr key={g.guild_id}>
                                <td><strong>{g.name || '(unnamed)'}</strong><div className="help"><code>{g.guild_id}</code></div></td>
                                <td>{g.owner_discord_id ? <code>{g.owner_discord_id}</code> : <span className="help">unknown</span>}</td>
                                <td>{g.bot_installed && !g.removed_at ? <Status value="active" label="installed" /> : <Status value="expired" label={g.removed_at ? 'removed' : 'not installed'} />}<div className="help"><When at={g.removed_at || g.installed_at} /></div></td>
                                <td>{g.premium ? <Status value={g.premium.active ? 'active' : g.premium.status} label={`${g.premium.period} · ${g.premium.status}`} /> : <span className="help">free</span>}</td>
                                <td>{protection(g.security)}</td>
                                <td className="num">{g.openIncidents ? <a href={`/admin/security?status=open`}>{g.openIncidents}</a> : 0}</td>
                                <td><a href={`/admin/servers/${g.guild_id}`}>View</a></td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
            <Pager base="/admin/servers" params={{ q }} page={data.page} total={data.total} pageSize={PAGE_SIZE} />
        </>
    );
}
