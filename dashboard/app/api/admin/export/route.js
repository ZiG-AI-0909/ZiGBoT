import shared from '@/lib/shared';
import stats from '@/lib/shared/adminStats';
import { handler, HttpError } from '@/lib/http';
import { requireSuperAdmin, adminRateLimit, writeAdminAudit } from '@/lib/admin';
import { createServiceClient } from '@/lib/supabase/server';
import { exportFeedbackRows } from '@/lib/adminData';

const { optionLabel } = shared;

export const dynamic = 'force-dynamic';

const MAX_ROWS = 2000;
const money = (paise, currency) => (Number.isInteger(paise) ? (paise / 100).toFixed(2) + (currency ? ` ${currency}` : '') : '');
const labels = (field) => (row) => (row[field] || []).map((k) => optionLabel(field, k));

const FEEDBACK_COLUMNS = [
    { label: 'Submission ID', get: (r) => r.id },
    { label: 'Submitted at (UTC)', get: (r) => r.submitted_at },
    { label: 'Discord username', get: (r) => r.username },
    { label: 'Discord user ID', get: (r) => r.discord_user_id },
    { label: 'Plan', get: (r) => (r.plan_period === 'yearly' ? 'Yearly' : 'Monthly') },
    { label: 'Amount', get: (r) => money(r.amount_paise, r.currency) },
    { label: 'Overall rating (1-5)', get: (r) => r.overall_rating },
    { label: 'Activation ease (1-5)', get: (r) => r.activation_ease },
    { label: 'Value for money', get: (r) => optionLabel('value_for_money', r.value_for_money) },
    { label: 'Recommend (0-10)', get: (r) => r.recommend_score },
    { label: 'Purchase reasons', get: labels('purchase_reasons') },
    { label: 'Most valuable features', get: labels('valuable_features') },
    { label: 'Issues', get: labels('issues') },
    { label: 'Issue details', get: (r) => r.issue_details },
    { label: 'Missing features', get: (r) => r.missing_features },
    { label: 'Other comments', get: (r) => r.comments },
    { label: 'Plan-specific answers', get: (r) => JSON.stringify(r.plan_answers || {}) },
    { label: 'Review status', get: (r) => r.review_status },
    { label: 'Archived at', get: (r) => r.archived_at }
    // The private admin note is deliberately not exported.
];

const PURCHASE_COLUMNS = [
    { label: 'Purchase ID', get: (r) => r.id },
    { label: 'Verified at (UTC)', get: (r) => r.verified_at },
    { label: 'Razorpay subscription', get: (r) => r.subscription_id },
    { label: 'Server ID', get: (r) => r.guild_id },
    { label: 'Buyer Discord ID', get: (r) => r.discord_user_id },
    { label: 'Plan', get: (r) => r.plan_period },
    { label: 'Amount', get: (r) => money(r.amount_paise, r.currency) },
    { label: 'First purchase', get: (r) => (r.is_first_purchase ? 'yes' : 'no') }
];

// GET ?type=feedback|purchases[&feedback filters] — CSV, Super Admin only,
// recorded in the admin audit log.
export const GET = handler(async (request) => {
    const admin = await requireSuperAdmin();
    adminRateLimit(admin.discordId, { max: 10 });
    const params = Object.fromEntries(new URL(request.url).searchParams);
    let rows;
    let columns;
    if (params.type === 'feedback') {
        try {
            rows = await exportFeedbackRows(params);
        } catch {
            throw new HttpError(502, 'Could not load feedback.');
        }
        columns = FEEDBACK_COLUMNS;
    } else if (params.type === 'purchases') {
        const { data, error } = await createServiceClient().from('zb_premium_purchases').select('*').order('verified_at', { ascending: false }).limit(MAX_ROWS);
        if (error) throw new HttpError(502, 'Could not load purchases.');
        rows = data || [];
        columns = PURCHASE_COLUMNS;
    } else {
        throw new HttpError(400, 'Pick type=feedback or type=purchases.');
    }
    await writeAdminAudit(admin, { action: `export.${params.type}`, targetType: params.type, metadata: { rows: rows.length, filters: Object.fromEntries(Object.entries(params).filter(([k]) => k !== 'type').slice(0, 10)) } });
    return new Response(stats.toCsv(rows, columns), {
        headers: {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': `attachment; filename="zigbot-${params.type}-${new Date().toISOString().slice(0, 10)}.csv"`,
            'Cache-Control': 'no-store'
        }
    });
});
