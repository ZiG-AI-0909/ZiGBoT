import { notFound } from 'next/navigation';
import { getSuperAdmin } from '@/lib/admin';
import { loadOverview } from '@/lib/adminData';
import { BarChart } from '@/components/admin/ui';

export const dynamic = 'force-dynamic';

// Usage analytics from stored records only. Message volume and AI usage are
// not stored anywhere (by design, for privacy), so they are not shown.
export default async function AdminAnalytics() {
    if (!(await getSuperAdmin())) notFound();
    const { charts, payments } = await loadOverview();
    return (
        <>
            <header className="adm-top"><h1>Analytics</h1><span className="help">Last 12 months (UTC)</span></header>
            <div className="adm-grid">
                <BarChart title="New users per month" data={charts.users} unavailable="Users could not be loaded." />
                <BarChart title="Verified purchases per month" data={charts.purchases} unavailable="Purchases are not tracked yet (feedback migration)." />
                <BarChart title="Revenue collected per month (₹)" data={charts.revenue} format={(v) => `₹${Math.round(v).toLocaleString('en-IN')}`} unavailable={payments.reason} />
                <BarChart title="Purchases by plan" data={charts.plans} unavailable="Purchases are not tracked yet." />
                <BarChart title="Feedback: overall rating" data={charts.ratings} unavailable="No feedback data." />
                <BarChart title="Security incidents per month" data={charts.incidents} unavailable="Incidents could not be loaded." />
            </div>
            <p className="help">Not shown because ZiGBoT does not store it: message counts, AI requests per server, and command usage. Bot errors live in the Render logs.</p>
        </>
    );
}
