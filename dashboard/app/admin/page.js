import { notFound } from 'next/navigation';
import { getSuperAdmin } from '@/lib/admin';
import { loadOverview } from '@/lib/adminData';
import { StatCard, BarChart, When } from '@/components/admin/ui';

export const dynamic = 'force-dynamic';

const num = (v) => (v === null || v === undefined ? null : v.toLocaleString('en-IN'));

export default async function AdminOverview() {
    if (!(await getSuperAdmin())) notFound();
    const data = await loadOverview();
    const { cards, health, charts, payments } = data;
    return (
        <>
            <header className="adm-top"><h1>Overview</h1><span className="help">Live from Supabase and Razorpay</span></header>

            {health.bot === null ? <div className="notice" role="alert">The bot has never reported a heartbeat to this dashboard.</div>
                : health.bot.stale ? <div className="notice" role="alert">⚠️ The bot&apos;s last heartbeat was <When at={health.bot.lastSeenAt} />. It may be offline.</div> : null}

            <div className="adm-cards">
                <StatCard label="Registered users" value={num(cards.users)} hint="Signed in to the dashboard at least once" unavailable="Could not count users." />
                <StatCard label="Servers with ZiGBoT" value={num(cards.servers)} hint={health.bot ? `Bot reports ${health.bot.guildCount}` : null} unavailable="Could not count servers." />
                <StatCard label="Active Premium" value={num(cards.activePremium)} hint="Subscriptions Razorpay reports as active (or paid up to period end)" unavailable="Subscriptions table missing." />
                <StatCard label="Verified purchases" value={num(cards.purchases)} hint="Subscriptions Razorpay confirmed as paid" unavailable="Run the feedback migration to track purchases." />
                <StatCard label="Revenue collected" value={cards.revenue} hint={payments.available ? `Captured minus refunds, last ${payments.items.length} Razorpay payments${payments.limited ? ' (older not included)' : ''}` : null} unavailable={payments.reason} />
                <StatCard label="Feedback responses" value={num(cards.feedback)} unavailable="Run the feedback migration." />
                <StatCard label="Avg satisfaction" value={cards.avgSatisfaction === null ? null : `${cards.avgSatisfaction} / 5`} unavailable="No feedback yet." />
                <StatCard label="Open CRITICAL incidents" value={num(cards.openCritical)} hint={<a href="/admin/security?severity=CRITICAL&status=open">View</a>} unavailable="Run the Anti-Nuke migration." />
                <StatCard label="Bot errors" value={null} unavailable="Not tracked: bot errors go to the Render logs only." />
            </div>

            <div className="adm-grid">
                <BarChart title="New users per month" data={charts.users} unavailable="Users could not be loaded." />
                <BarChart title="Verified purchases per month" data={charts.purchases} unavailable="Purchases are not tracked yet (feedback migration)." />
                <BarChart title="Revenue collected per month (₹)" data={charts.revenue} format={(v) => `₹${Math.round(v).toLocaleString('en-IN')}`} unavailable={payments.reason} />
                <BarChart title="Purchases by plan" data={charts.plans} unavailable="Purchases are not tracked yet." />
                <BarChart title="Feedback: overall rating" data={charts.ratings} unavailable="No feedback data." />
                <BarChart title="Security incidents per month" data={charts.incidents} unavailable="Incidents could not be loaded." />
            </div>
        </>
    );
}
