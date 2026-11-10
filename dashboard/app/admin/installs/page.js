import { notFound } from 'next/navigation';
import { getSuperAdmin } from '@/lib/admin';
import { loadInstalls, PAGE_SIZE } from '@/lib/adminData';
import { Pager, StatCard, Status, When } from '@/components/admin/ui';

export const dynamic = 'force-dynamic';

const KINDS = { '': 'Everything', added: 'Added', removed: 'Removed' };

function what(e) {
    if (e.event_type === 'APPLICATION_AUTHORIZED') return <Status value="active" label={e.integration_type === 1 ? 'added to account' : 'added to server'} />;
    if (e.event_type === 'APPLICATION_DEAUTHORIZED') return <Status value="expired" label="removed from account" />;
    return <Status value="expired" label="removed from server" />;
}

export default async function AdminInstalls({ searchParams }) {
    if (!(await getSuperAdmin())) notFound();
    const params = await searchParams;
    const kind = KINDS[params?.kind] ? String(params.kind) : '';
    const data = await loadInstalls({ kind, page: params?.page });
    return (
        <>
            <header className="adm-top"><h1>Installs</h1><span className="help">Who added or removed ZiGBoT, from Discord&apos;s webhook and the bot</span></header>
            {data.last30 ? (
                <div className="adm-cards">
                    <StatCard label="Added (30 days)" value={data.last30.added} unavailable="Could not count." />
                    <StatCard label="Removed (30 days)" value={data.last30.removed} unavailable="Could not count." />
                </div>
            ) : null}
            <form className="adm-filters" method="get">
                <label className="field">
                    <span className="help">Show</span>
                    <select name="kind" defaultValue={kind}>
                        {Object.entries(KINDS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                    </select>
                </label>
                <button className="btn" type="submit">Filter</button>
            </form>
            {data.error ? <div className="notice" role="alert">{data.error}</div> : null}
            <div className="adm-table-wrap">
                <table className="adm-table">
                    <thead><tr><th>When</th><th>What</th><th>Server</th><th>By</th></tr></thead>
                    <tbody>
                        {data.events.length === 0 ? <tr><td colSpan={4} className="help">Nothing yet. Events appear once the Discord webhook is set up.</td></tr> : data.events.map((e) => (
                            <tr key={e.id}>
                                <td><When at={e.occurred_at} /></td>
                                <td>{what(e)}</td>
                                <td>{e.guild_id ? <><strong>{e.guild_name || '(unnamed)'}</strong><div className="help"><a href={`/admin/servers/${e.guild_id}`}><code>{e.guild_id}</code></a></div></> : <span className="help">—</span>}</td>
                                <td>{e.user_discord_id ? <>{e.user_name || 'unknown'}<div className="help"><code>{e.user_discord_id}</code></div></> : <span className="help">—</span>}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
            <Pager base="/admin/installs" params={{ kind }} page={data.page} total={data.total} pageSize={PAGE_SIZE} />
        </>
    );
}
