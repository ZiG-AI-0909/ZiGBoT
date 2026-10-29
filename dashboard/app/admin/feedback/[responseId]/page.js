import { notFound } from 'next/navigation';
import shared from '@/lib/shared';
import stats from '@/lib/shared/adminStats';
import { getSuperAdmin } from '@/lib/admin';
import { loadFeedbackDetail } from '@/lib/adminData';
import { When } from '@/components/admin/ui';
import ReviewActions from '@/components/admin/ReviewActions';

export const dynamic = 'force-dynamic';
const { optionLabel, planLabel, FEEDBACK_RATING_LABELS, FEEDBACK_EASE_LABELS } = shared;

const list = (field, keys) => (keys?.length ? keys.map((k) => optionLabel(field, k)).join(', ') : <span className="help">none selected</span>);
const text = (value) => (value ? <span style={{ whiteSpace: 'pre-wrap' }}>{value}</span> : <span className="help">—</span>);

export default async function FeedbackResponse({ params }) {
    if (!(await getSuperAdmin())) notFound();
    const { responseId } = await params;
    const data = await loadFeedbackDetail(responseId);
    if (!data) notFound();
    const { response: r, profile, purchase } = data;
    const answers = r.plan_answers || {};
    return (
        <>
            <header className="adm-top"><h1>Response <code style={{ fontSize: 16 }}>{r.id.slice(0, 8)}</code></h1><a className="btn" href="/admin/feedback">All responses</a></header>
            <div className="adm-grid">
                <section className="card stack">
                    <h2 style={{ margin: 0 }}>Customer &amp; purchase</h2>
                    <dl className="adm-dl">
                        <dt>Form</dt><dd>First-Time Premium Feedback — {r.plan_period === 'yearly' ? '₹3,999' : '₹399'} plan</dd>
                        <dt>User</dt><dd>{profile?.username || 'unknown'}{r.user_id ? <> · <a href={`/admin/users/${r.user_id}`}>profile</a></> : null}</dd>
                        <dt>Discord user ID</dt><dd>{r.discord_user_id ? <code>{r.discord_user_id}</code> : '—'}</dd>
                        <dt>Plan (verified)</dt><dd>{planLabel(r)} · {stats.formatMoney(r.amount_paise, r.currency || 'INR')}</dd>
                        <dt>Subscription</dt><dd>{purchase ? <code>{purchase.subscription_id}</code> : '—'}</dd>
                        <dt>Server</dt><dd>{purchase ? <a href={`/admin/servers/${purchase.guild_id}`}><code>{purchase.guild_id}</code></a> : '—'}</dd>
                        <dt>Purchased</dt><dd><When at={purchase?.verified_at} /></dd>
                        <dt>Submitted</dt><dd><When at={r.submitted_at} /></dd>
                    </dl>
                </section>
                <ReviewActions response={{ id: r.id, review_status: r.review_status, archived_at: r.archived_at, admin_note: r.admin_note }} />
            </div>
            <section className="card stack" style={{ marginTop: 16 }}>
                <h2 style={{ margin: 0 }}>Answers (as submitted)</h2>
                <dl className="adm-dl">
                    <dt>Overall experience</dt><dd>{r.overall_rating}★ — {FEEDBACK_RATING_LABELS[r.overall_rating - 1]}</dd>
                    <dt>Purchase reasons</dt><dd>{list('purchase_reasons', r.purchase_reasons)}</dd>
                    <dt>Most exciting features</dt><dd>{list('valuable_features', r.valuable_features)}</dd>
                    <dt>Ease of purchase</dt><dd>{r.activation_ease}/5 — {FEEDBACK_EASE_LABELS[r.activation_ease - 1]}</dd>
                    <dt>Value for money</dt><dd>{optionLabel('value_for_money', r.value_for_money)}</dd>
                    {r.plan_period === 'yearly' ? (
                        <>
                            <dt>Worth the yearly price</dt><dd>{answers.justifies_price ? optionLabel('justifies_price', answers.justifies_price) : '—'}</dd>
                            <dt>Important capabilities</dt><dd>{list('advanced_capabilities', answers.advanced_capabilities)}</dd>
                            <dt>Meets server needs</dt><dd>{answers.meets_requirements ? optionLabel('meets_requirements', answers.meets_requirements) : '—'}</dd>
                            <dt>Wants setup help</dt><dd>{answers.needs_onboarding ? optionLabel('needs_onboarding', answers.needs_onboarding) : '—'}</dd>
                        </>
                    ) : (
                        <>
                            <dt>Meets expectations</dt><dd>{answers.meets_expectations ? optionLabel('meets_expectations', answers.meets_expectations) : '—'}</dd>
                            <dt>Would make it more useful</dt><dd>{text(answers.more_useful)}</dd>
                        </>
                    )}
                    <dt>Missing features</dt><dd>{text(r.missing_features)}</dd>
                    <dt>Problems</dt><dd>{list('issues', r.issues)}</dd>
                    <dt>Problem details</dt><dd>{text(r.issue_details)}</dd>
                    <dt>Recommend (0-10)</dt><dd>{r.recommend_score}</dd>
                    <dt>Anything else</dt><dd>{text(r.comments)}</dd>
                </dl>
            </section>
        </>
    );
}
