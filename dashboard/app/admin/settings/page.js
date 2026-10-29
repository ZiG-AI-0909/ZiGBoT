import { notFound } from 'next/navigation';
import { getSuperAdmin } from '@/lib/admin';
import { loadAudit, adminConfig, PAGE_SIZE } from '@/lib/adminData';
import { Pager, Status, When } from '@/components/admin/ui';

export const dynamic = 'force-dynamic';

const on = (value) => (value ? <Status value="active" label="configured" /> : <Status value="expired" label="not configured" />);

export default async function AdminSettings({ searchParams }) {
    const admin = await getSuperAdmin();
    if (!admin) notFound();
    const params = await searchParams;
    const config = adminConfig();
    const audit = await loadAudit({ page: params?.page });
    return (
        <>
            <header className="adm-top"><h1>Settings &amp; Audit</h1></header>
            <section className="card stack">
                <h2 style={{ margin: 0 }}>Admin access</h2>
                <p className="help" style={{ margin: 0 }}>
                    Super Admins are set only in the dashboard&apos;s server environment (<code>SUPER_ADMIN_DISCORD_IDS</code>, comma-separated Discord user IDs; falls back to <code>BOT_CREATOR_ID</code>).
                    Nothing on this site can add an admin. Change it in Vercel → Settings → Environment Variables and redeploy.
                </p>
                <dl className="adm-dl">
                    <dt>Configured admins</dt><dd>{config.adminCount}</dd>
                    <dt>You</dt><dd>Discord <code>{admin.discordId}</code></dd>
                    <dt>Razorpay billing</dt><dd>{on(config.billingEnabled)}</dd>
                    <dt>Razorpay webhook</dt><dd>{on(config.webhookEnabled)}</dd>
                    <dt>BOT_CREATOR_ID (identity review)</dt><dd>{on(config.botCreatorSet)}</dd>
                    <dt>Custom bot identity</dt><dd>{config.customIdentityEnabled ? <Status value="active" label="on" /> : <Status value="expired" label="off" />}</dd>
                </dl>
            </section>

            <h2>Admin audit log</h2>
            <p className="help">Every consequential admin action (reviews, notes, archives, incident status, exports). Append-only: it cannot be edited or deleted, even by the database&apos;s service role.</p>
            {audit.error ? <div className="notice" role="alert">{audit.error}</div> : null}
            <div className="adm-table-wrap">
                <table className="adm-table">
                    <thead><tr><th>When</th><th>Admin</th><th>Action</th><th>Target</th><th>Outcome</th><th>Details</th></tr></thead>
                    <tbody>
                        {audit.entries.length === 0 ? <tr><td colSpan={6} className="help">No admin actions recorded yet.</td></tr> : audit.entries.map((e) => (
                            <tr key={e.id}>
                                <td><When at={e.created_at} /></td>
                                <td><code>{e.admin_discord_id}</code></td>
                                <td>{e.action}</td>
                                <td>{e.target_type ? `${e.target_type} ` : ''}{e.target_id ? <code>{e.target_id}</code> : null}</td>
                                <td><Status value={e.outcome === 'ok' ? 'active' : 'failed'} label={e.outcome} /></td>
                                <td><code className="small">{JSON.stringify(e.metadata)}</code></td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
            <Pager base="/admin/settings" page={audit.page} total={audit.total} pageSize={PAGE_SIZE} />
        </>
    );
}
