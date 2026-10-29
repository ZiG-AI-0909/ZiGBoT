import { notFound } from 'next/navigation';
import shared from '@/lib/shared';
import stats from '@/lib/shared/adminStats';
import { getSuperAdmin } from '@/lib/admin';
import { loadPremium, PAGE_SIZE } from '@/lib/adminData';
import { Pager, Status, StatCard, When, Unavailable } from '@/components/admin/ui';

export const dynamic = 'force-dynamic';
const { planLabel, isPremiumActive } = shared;

export default async function AdminPremium({ searchParams }) {
    if (!(await getSuperAdmin())) notFound();
    const params = await searchParams;
    const data = await loadPremium({ page: params?.page });
    const { payments } = data;
    const s = payments.summary;
    const money = (paise) => stats.formatMoney(paise, s?.currency || 'INR');
    const subs = data.subscriptions.data || [];
    return (
        <>
            <header className="adm-top">
                <h1>Premium &amp; Revenue</h1>
                <a className="btn" href="/api/admin/export?type=purchases">Export purchases (CSV)</a>
            </header>

            <h2>Money (from Razorpay)</h2>
            {!payments.available ? <Unavailable>{payments.reason}</Unavailable> : (
                <>
                    <div className="adm-cards">
                        <StatCard label="Collected" value={money(s.collectedPaise)} hint="Captured payments minus refunds" />
                        <StatCard label="Refunded" value={money(s.refundedPaise)} hint="Not revenue" />
                        <StatCard label="Pending" value={`${s.pendingCount} · ${money(s.pendingPaise)}`} hint="Authorized, not captured: not revenue yet" />
                        <StatCard label="Failed payments" value={String(s.failedCount)} hint="Never revenue" />
                    </div>
                    <p className="help">Based on the latest {payments.items.length} payments on the Razorpay account{payments.limited ? '; older ones are not included' : ''}. Refunds are issued from the Razorpay dashboard; this page is read-only.</p>
                    <div className="adm-table-wrap">
                        <table className="adm-table">
                            <thead><tr><th>Date</th><th>Payment</th><th>Status</th><th>Amount</th><th>Refunded</th><th>Method</th></tr></thead>
                            <tbody>
                                {payments.items.length === 0 ? <tr><td colSpan={6} className="help">No payments yet.</td></tr> : payments.items.slice(0, 50).map((p) => (
                                    <tr key={p.id}>
                                        <td><When at={p.created_at * 1000} /></td>
                                        <td><code>{p.id}</code></td>
                                        <td><Status value={p.status} /></td>
                                        <td className="num">{stats.formatMoney(p.amount, p.currency)}</td>
                                        <td className="num">{p.amount_refunded ? stats.formatMoney(p.amount_refunded, p.currency) : '—'}{p.refund_status ? <div className="help">{p.refund_status}</div> : null}</td>
                                        <td>{p.method || '—'}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </>
            )}

            <h2>Verified purchases</h2>
            <p className="help">One row per subscription Razorpay confirmed as paid (renewals are not new purchases). Recorded from when the feedback migration was applied.</p>
            {data.purchasesError ? <Unavailable>{data.purchasesError}</Unavailable> : (
                <>
                    <div className="adm-table-wrap">
                        <table className="adm-table">
                            <thead><tr><th>Verified</th><th>Buyer</th><th>Plan</th><th>Amount</th><th>Server</th><th>Subscription</th></tr></thead>
                            <tbody>
                                {data.purchases.length === 0 ? <tr><td colSpan={6} className="help">No verified purchases yet.</td></tr> : data.purchases.map((p) => (
                                    <tr key={p.id}>
                                        <td><When at={p.verified_at} /></td>
                                        <td>{p.user_id ? <a href={`/admin/users/${p.user_id}`}>{p.username || p.discord_user_id || 'user'}</a> : <span className="help">unknown</span>}</td>
                                        <td>{planLabel(p)}{p.is_first_purchase ? <span className="help"> · first</span> : null}</td>
                                        <td className="num">{stats.formatMoney(p.amount_paise, p.currency || 'INR')}</td>
                                        <td><a href={`/admin/servers/${p.guild_id}`}><code>{p.guild_id}</code></a></td>
                                        <td><code>{p.subscription_id}</code></td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                    <Pager base="/admin/premium" page={data.page} total={data.total} pageSize={PAGE_SIZE} />
                </>
            )}

            <h2>Subscriptions by server</h2>
            {data.subscriptions.error ? <Unavailable>{data.subscriptions.error}</Unavailable> : (
                <div className="adm-table-wrap">
                    <table className="adm-table">
                        <thead><tr><th>Server</th><th>Plan</th><th>Status</th><th>Entitlement</th><th>Period ends</th></tr></thead>
                        <tbody>
                            {subs.length === 0 ? <tr><td colSpan={5} className="help">No subscriptions.</td></tr> : subs.map((x) => (
                                <tr key={x.guild_id}>
                                    <td><a href={`/admin/servers/${x.guild_id}`}><code>{x.guild_id}</code></a></td>
                                    <td>{x.plan_period}</td>
                                    <td><Status value={x.status} />{x.pending_subscription_id ? <div className="help">checkout pending</div> : null}</td>
                                    <td>{isPremiumActive(x) ? <Status value="active" label="Premium on" /> : <Status value="expired" label="Premium off" />}{x.cancel_at_period_end ? <div className="help">cancels at period end</div> : null}</td>
                                    <td><When at={x.current_period_end} /></td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </>
    );
}
