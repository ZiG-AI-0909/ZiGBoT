import { notFound } from 'next/navigation';
import shared from '@/lib/shared';
import stats from '@/lib/shared/adminStats';
import { getSuperAdmin } from '@/lib/admin';
import { loadUserDetail } from '@/lib/adminData';
import { Status, When, Unavailable } from '@/components/admin/ui';

export const dynamic = 'force-dynamic';
const { planLabel } = shared;

export default async function AdminUser({ params }) {
    if (!(await getSuperAdmin())) notFound();
    const { userId } = await params;
    const data = await loadUserDetail(userId);
    if (!data) notFound();
    const { profile, account, purchases, feedback, guilds } = data;
    return (
        <>
            <header className="adm-top"><h1>{profile.username || 'User'}</h1><a className="btn" href="/admin/users">All users</a></header>
            <section className="card stack">
                <dl className="adm-dl">
                    <dt>Discord user ID</dt><dd><code>{profile.discord_user_id}</code></dd>
                    <dt>Account ID</dt><dd><code>{profile.user_id}</code></dd>
                    <dt>Registered</dt><dd><When at={account?.createdAt || profile.created_at} /></dd>
                    <dt>Last sign-in</dt><dd>{account ? <When at={account.lastSignInAt} /> : <span className="adm-unavailable">unavailable</span>}</dd>
                    <dt>Login</dt><dd>{account?.provider ? `Discord OAuth (${account.provider})` : 'Discord OAuth'}</dd>
                </dl>
                <p className="help" style={{ margin: 0 }}>Tokens, emails and payment details are never shown here. Private conversations are not accessible from the admin area.</p>
            </section>

            <h2>Premium purchases</h2>
            {purchases.error ? <Unavailable>{purchases.error}</Unavailable> : (
                <div className="adm-table-wrap">
                    <table className="adm-table">
                        <thead><tr><th>Verified</th><th>Plan</th><th>Amount</th><th>Server</th><th>Subscription</th><th>Feedback</th></tr></thead>
                        <tbody>
                            {purchases.data.length === 0 ? <tr><td colSpan={6} className="help">No verified purchases.</td></tr> : purchases.data.map((p) => (
                                <tr key={p.id}>
                                    <td><When at={p.verified_at} /></td>
                                    <td>{planLabel(p)}{p.is_first_purchase ? <span className="help"> · first</span> : null}</td>
                                    <td className="num">{stats.formatMoney(p.amount_paise, p.currency || 'INR')}</td>
                                    <td><a href={`/admin/servers/${p.guild_id}`}><code>{p.guild_id}</code></a></td>
                                    <td><code>{p.subscription_id}</code></td>
                                    <td><Status value={p.feedback_state === 'submitted' ? 'reviewed' : p.feedback_state === 'pending' ? 'pending' : null} label={p.feedback_state.replace('_', ' ')} /></td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            <h2>Feedback</h2>
            {feedback.error ? <Unavailable>{feedback.error}</Unavailable> : feedback.data.length === 0 ? <p className="help">No feedback submitted.</p> : (
                <ul>{feedback.data.map((f) => <li key={f.id}><a href={`/admin/feedback/${f.id}`}>{f.plan_period} · {f.overall_rating}★ · recommend {f.recommend_score}/10</a> · <When at={f.submitted_at} /> · <Status value={f.review_status} /></li>)}</ul>
            )}

            <h2>Servers they can see in the dashboard</h2>
            {guilds.error ? <Unavailable>{guilds.error}</Unavailable> : guilds.data.length === 0 ? <p className="help">None recorded.</p> : (
                <ul>{guilds.data.map((g) => <li key={g.guild_id}><a href={`/admin/servers/${g.guild_id}`}>{g.name || g.guild_id}</a>{g.can_manage ? <span className="help"> · can manage</span> : null}</li>)}</ul>
            )}
        </>
    );
}
