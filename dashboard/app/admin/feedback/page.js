import { notFound } from 'next/navigation';
import shared from '@/lib/shared';
import { getSuperAdmin } from '@/lib/admin';
import { loadFeedback, PAGE_SIZE } from '@/lib/adminData';
import { Pager, Status, StatCard, When, BarChart } from '@/components/admin/ui';

export const dynamic = 'force-dynamic';
const { FEEDBACK_OPTIONS, optionLabel } = shared;

// Every form ZiGBoT has. New forms get a row here.
const FORMS = [
    { plan: 'monthly', name: 'First-Time Premium Feedback — ₹399 plan' },
    { plan: 'yearly', name: 'First-Time Premium Feedback — ₹3,999 plan' }
];
const formName = (plan) => FORMS.find((f) => f.plan === plan)?.name || 'Premium feedback';
const FILTER_KEYS = ['q', 'plan', 'status', 'rating', 'from', 'to', 'issue', 'archived', 'sort'];
const show = (v, suffix = '') => (v === null || v === undefined ? '—' : `${v}${suffix}`);

export default async function FormsAndResponses({ searchParams }) {
    if (!(await getSuperAdmin())) notFound();
    const params = await searchParams;
    const filters = Object.fromEntries(FILTER_KEYS.map((k) => [k, String(params?.[k] || '')]));
    const data = await loadFeedback({ ...filters, page: params?.page });
    const st = data.stats;
    const exportQuery = new URLSearchParams({ type: 'feedback', ...Object.fromEntries(Object.entries(filters).filter(([, v]) => v)) });
    return (
        <>
            <header className="adm-top">
                <h1>Forms &amp; Responses</h1>
                <a className="btn" href={`/api/admin/export?${exportQuery.toString()}`}>Export CSV</a>
            </header>
            {data.error ? <div className="notice" role="alert">{data.error}</div> : null}

            {st ? (
                <>
                    <div className="adm-cards">
                        <StatCard label="Submissions (matching)" value={String(st.total)} />
                        <StatCard label="New" value={String(st.new)} hint="Not reviewed yet" />
                        <StatCard label="Reviewed" value={String(st.reviewed)} />
                        {FORMS.map((f) => <StatCard key={f.plan} label={f.name.replace('First-Time Premium Feedback — ', '')} value={String(st[f.plan].count)} hint={<a href={`/admin/feedback?plan=${f.plan}`}>Open this form</a>} />)}
                    </div>

                    <div className="adm-grid">
                        <BarChart title="Submissions per month" data={data.trend} unavailable="No data." />
                        <section className="card stack">
                            <h3 style={{ margin: 0, fontSize: 15 }}>₹399 vs ₹3,999</h3>
                            <div className="adm-table-wrap">
                                <table className="adm-table">
                                    <thead><tr><th /><th>All</th><th>₹399</th><th>₹3,999</th></tr></thead>
                                    <tbody>
                                        <tr><td>Satisfaction (1-5)</td><td className="num">{show(st.all.avgRating)}</td><td className="num">{show(st.monthly.avgRating)}</td><td className="num">{show(st.yearly.avgRating)}</td></tr>
                                        <tr><td>Activation ease (1-5)</td><td className="num">{show(st.all.avgEase)}</td><td className="num">{show(st.monthly.avgEase)}</td><td className="num">{show(st.yearly.avgEase)}</td></tr>
                                        <tr><td>Recommend (0-10)</td><td className="num">{show(st.all.avgRecommend)}</td><td className="num">{show(st.monthly.avgRecommend)}</td><td className="num">{show(st.yearly.avgRecommend)}</td></tr>
                                        <tr><td>NPS (-100..100)</td><td className="num">{show(st.all.nps)}</td><td className="num">{show(st.monthly.nps)}</td><td className="num">{show(st.yearly.nps)}</td></tr>
                                        {FEEDBACK_OPTIONS.value_for_money.map(([key, label]) => (
                                            <tr key={key}><td>Value: {label}</td><td className="num">{st.all.value[key]}</td><td className="num">{st.monthly.value[key]}</td><td className="num">{st.yearly.value[key]}</td></tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        </section>
                        <section className="card stack">
                            <h3 style={{ margin: 0, fontSize: 15 }}>Most valued features</h3>
                            {st.features.length ? <ol style={{ margin: 0 }}>{st.features.slice(0, 8).map((f) => <li key={f.key}>{f.label} <span className="help">· {f.count}</span></li>)}</ol> : <p className="help">No answers yet.</p>}
                            <h3 style={{ margin: 0, fontSize: 15 }}>Most reported problems</h3>
                            {st.issues.length ? <ol style={{ margin: 0 }}>{st.issues.map((f) => <li key={f.key}><a href={`/admin/feedback?issue=${f.key}`}>{f.label}</a> <span className="help">· {f.count}</span></li>)}</ol> : <p className="help">No problems reported. 🎉</p>}
                        </section>
                        <section className="card stack">
                            <h3 style={{ margin: 0, fontSize: 15 }}>Latest suggestions</h3>
                            {st.suggestions.length ? <ul style={{ margin: 0 }}>{st.suggestions.slice(0, 8).map((s) => <li key={s.id}><a href={`/admin/feedback/${s.id}`}>{s.text.length > 140 ? `${s.text.slice(0, 140)}…` : s.text}</a></li>)}</ul> : <p className="help">No written suggestions yet.</p>}
                        </section>
                    </div>
                </>
            ) : null}

            <h2>Responses</h2>
            <form className="adm-filters" method="get" aria-label="Filter responses">
                <label className="field" style={{ flex: 1, minWidth: 200 }}><span className="help">Discord username or user ID</span><input name="q" defaultValue={filters.q} /></label>
                <label className="field"><span className="help">Form</span>
                    <select name="plan" defaultValue={filters.plan}><option value="">All forms</option>{FORMS.map((f) => <option key={f.plan} value={f.plan}>{f.name.replace('First-Time Premium Feedback — ', '')}</option>)}</select>
                </label>
                <label className="field"><span className="help">Review status</span>
                    <select name="status" defaultValue={filters.status}><option value="">Any</option><option value="new">New</option><option value="reviewed">Reviewed</option></select>
                </label>
                <label className="field"><span className="help">Rating</span>
                    <select name="rating" defaultValue={filters.rating}><option value="">Any</option>{[5, 4, 3, 2, 1].map((n) => <option key={n} value={n}>{n}★</option>)}</select>
                </label>
                <label className="field"><span className="help">Problem</span>
                    <select name="issue" defaultValue={filters.issue}><option value="">Any</option>{FEEDBACK_OPTIONS.issues.filter(([k]) => k !== 'none').map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
                </label>
                <label className="field"><span className="help">From</span><input type="date" name="from" defaultValue={filters.from} /></label>
                <label className="field"><span className="help">To</span><input type="date" name="to" defaultValue={filters.to} /></label>
                <label className="field"><span className="help">Archived</span>
                    <select name="archived" defaultValue={filters.archived}><option value="">Hide archived</option><option value="only">Only archived</option><option value="all">Include archived</option></select>
                </label>
                <label className="field"><span className="help">Sort</span>
                    <select name="sort" defaultValue={filters.sort}><option value="newest">Newest first</option><option value="oldest">Oldest first</option></select>
                </label>
                <button className="btn" type="submit">Apply</button>
                <a className="btn btn-ghost" href="/admin/feedback">Reset</a>
            </form>
            <div className="adm-table-wrap">
                <table className="adm-table">
                    <thead><tr><th>Submission</th><th>Form</th><th>User</th><th>User ID</th><th>Plan</th><th>Submitted</th><th>Rating</th><th>Status</th><th /></tr></thead>
                    <tbody>
                        {data.responses.length === 0 ? <tr><td colSpan={9} className="help">No responses match.</td></tr> : data.responses.map((r) => (
                            <tr key={r.id}>
                                <td><code title={r.id}>{r.id.slice(0, 8)}</code></td>
                                <td>{formName(r.plan_period)}</td>
                                <td>{r.username || <span className="help">unknown</span>}</td>
                                <td>{r.discord_user_id ? <code>{r.discord_user_id}</code> : '—'}</td>
                                <td>{r.plan_period === 'yearly' ? '₹3,999' : '₹399'}</td>
                                <td><When at={r.submitted_at} /></td>
                                <td className="num">{r.overall_rating}★</td>
                                <td><Status value={r.archived_at ? 'archived' : r.review_status} /></td>
                                <td><a href={`/admin/feedback/${r.id}`}>View Details</a></td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
            <Pager base="/admin/feedback" params={filters} page={data.page} total={data.total} pageSize={PAGE_SIZE} />
            <p className="help">Issue labels: {FEEDBACK_OPTIONS.issues.map(([k]) => optionLabel('issues', k)).join(' · ')}</p>
        </>
    );
}
