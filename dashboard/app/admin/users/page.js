import { notFound } from 'next/navigation';
import { getSuperAdmin } from '@/lib/admin';
import { loadUsers, PAGE_SIZE } from '@/lib/adminData';
import { Pager, Status, When } from '@/components/admin/ui';

export const dynamic = 'force-dynamic';

export default async function AdminUsers({ searchParams }) {
    if (!(await getSuperAdmin())) notFound();
    const params = await searchParams;
    const q = String(params?.q || '');
    const data = await loadUsers({ q, page: params?.page });
    return (
        <>
            <header className="adm-top"><h1>Users</h1><span className="help">Everyone who signed in to the dashboard with Discord</span></header>
            <form className="adm-filters" method="get">
                <label className="field" style={{ flex: 1, minWidth: 220 }}>
                    <span className="help">Search by Discord username or user ID</span>
                    <input name="q" defaultValue={q} placeholder="e.g. zig or 123456789012345678" />
                </label>
                <button className="btn" type="submit">Search</button>
            </form>
            {data.error ? <div className="notice" role="alert">{data.error}</div> : null}
            <div className="adm-table-wrap">
                <table className="adm-table">
                    <thead><tr><th>User</th><th>Discord ID</th><th>Registered</th><th>Premium</th><th /></tr></thead>
                    <tbody>
                        {data.users.length === 0 ? <tr><td colSpan={5} className="help">No users match.</td></tr> : data.users.map((u) => (
                            <tr key={u.user_id}>
                                <td><strong>{u.username || '(no name)'}</strong></td>
                                <td><code>{u.discord_user_id}</code></td>
                                <td><When at={u.created_at} /></td>
                                <td>{u.purchases.length ? <Status value="active" label={`${u.purchases.length} purchase${u.purchases.length > 1 ? 's' : ''}`} /> : <span className="help">none</span>}</td>
                                <td><a href={`/admin/users/${u.user_id}`}>View</a></td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
            <Pager base="/admin/users" params={{ q }} page={data.page} total={data.total} pageSize={PAGE_SIZE} />
            <p className="help">Suspending dashboard access is not available: the current login model has no suspension state. Remove someone&apos;s Discord permissions in their server instead.</p>
        </>
    );
}
