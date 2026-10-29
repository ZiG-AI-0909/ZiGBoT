/**
 * Super Admin aggregations. Pure functions over rows already loaded from
 * the database or Razorpay, so every number on /admin is computed the same,
 * tested way and nothing is invented: an unknown value stays null.
 * CommonJS, like the rest of lib/shared.
 */
const { optionLabel } = require('./feedback');

const MONTH = new Intl.DateTimeFormat('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });

/** The last `months` calendar months (UTC), oldest first, as { key: '2026-10', label: 'Oct 2026' }. */
function lastMonths(months = 12, now = Date.now()) {
    const d = new Date(now);
    const out = [];
    for (let i = months - 1; i >= 0; i -= 1) {
        const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1));
        out.push({ key: m.toISOString().slice(0, 7), label: MONTH.format(m) });
    }
    return out;
}

/** Sum value(item) per month of date(item); items outside the window are ignored. */
function monthlySeries(items, { date, value = () => 1, months = 12, now = Date.now() }) {
    const buckets = lastMonths(months, now).map((m) => ({ ...m, value: 0 }));
    const index = new Map(buckets.map((b, i) => [b.key, i]));
    for (const item of items || []) {
        const at = date(item);
        const key = at ? new Date(at).toISOString().slice(0, 7) : null;
        if (key && index.has(key)) buckets[index.get(key)].value += Number(value(item)) || 0;
    }
    return buckets;
}

const avg = (values) => {
    const list = values.filter((v) => Number.isFinite(v));
    return list.length ? Math.round((list.reduce((a, b) => a + b, 0) / list.length) * 10) / 10 : null;
};

function countOptions(rows, field) {
    const counts = new Map();
    for (const row of rows) for (const key of row[field] || []) counts.set(key, (counts.get(key) || 0) + 1);
    return [...counts.entries()].map(([key, count]) => ({ key, label: optionLabel(field, key), count })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

/** Net Promoter Score (-100..100) from 0-10 scores, or null with no answers. */
function nps(scores) {
    const list = scores.filter((s) => Number.isInteger(s));
    if (list.length === 0) return null;
    const promoters = list.filter((s) => s >= 9).length;
    const detractors = list.filter((s) => s <= 6).length;
    return Math.round(((promoters - detractors) / list.length) * 100);
}

/** Everything the feedback views show, from stored responses. */
function feedbackStats(rows) {
    const list = rows || [];
    const byPlan = (period) => list.filter((r) => r.plan_period === period);
    const planStats = (subset) => ({
        count: subset.length,
        avgRating: avg(subset.map((r) => r.overall_rating)),
        avgEase: avg(subset.map((r) => r.activation_ease)),
        avgRecommend: avg(subset.map((r) => r.recommend_score)),
        nps: nps(subset.map((r) => r.recommend_score)),
        value: Object.fromEntries(['excellent', 'good', 'fair', 'too_expensive', 'need_time'].map((k) => [k, subset.filter((r) => r.value_for_money === k).length]))
    });
    return {
        total: list.length,
        new: list.filter((r) => r.review_status === 'new' && !r.archived_at).length,
        reviewed: list.filter((r) => r.review_status === 'reviewed').length,
        archived: list.filter((r) => r.archived_at).length,
        all: planStats(list),
        monthly: planStats(byPlan('monthly')),
        yearly: planStats(byPlan('yearly')),
        ratingDistribution: [1, 2, 3, 4, 5].map((n) => ({ key: String(n), label: `${n}★`, value: list.filter((r) => r.overall_rating === n).length })),
        features: countOptions(list, 'valuable_features'),
        reasons: countOptions(list, 'purchase_reasons'),
        issues: countOptions(list, 'issues').filter((i) => i.key !== 'none'),
        suggestions: list.filter((r) => r.missing_features || r.comments).map((r) => ({ id: r.id, at: r.submitted_at, plan: r.plan_period, text: [r.missing_features, r.comments].filter(Boolean).join(' — ') }))
    };
}

/**
 * Money from Razorpay payment entities (amounts in paise). Only CAPTURED
 * payments count as collected, minus anything refunded; authorized/created
 * are pending, failed are failed. Nothing else is revenue.
 */
function paymentsSummary(payments) {
    const list = payments || [];
    const sum = (subset, pick) => subset.reduce((a, p) => a + (Number(pick(p)) || 0), 0);
    const captured = list.filter((p) => p.status === 'captured' || p.status === 'refunded');
    const refunded = sum(list, (p) => p.amount_refunded);
    return {
        currency: list.find((p) => p.currency)?.currency || 'INR',
        collectedPaise: sum(captured, (p) => p.amount) - refunded,
        grossPaise: sum(captured, (p) => p.amount),
        refundedPaise: refunded,
        capturedCount: captured.length,
        pendingCount: list.filter((p) => p.status === 'authorized' || p.status === 'created').length,
        pendingPaise: sum(list.filter((p) => p.status === 'authorized' || p.status === 'created'), (p) => p.amount),
        failedCount: list.filter((p) => p.status === 'failed').length
    };
}

function formatMoney(paise, currency = 'INR') {
    if (!Number.isFinite(paise)) return '—';
    return new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: paise % 100 ? 2 : 0 }).format(paise / 100);
}

/**
 * CSV text. Cells that a spreadsheet would run as a formula (=, +, -, @,
 * tab, CR) are prefixed with an apostrophe (OWASP CSV injection).
 */
function toCsv(rows, columns) {
    const cell = (value) => {
        let text = value === null || value === undefined ? '' : Array.isArray(value) ? value.join('; ') : String(value);
        if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
        return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    const lines = [columns.map((c) => cell(c.label)).join(',')];
    for (const row of rows || []) lines.push(columns.map((c) => cell(c.get(row))).join(','));
    return `${lines.join('\r\n')}\r\n`;
}

module.exports = { lastMonths, monthlySeries, feedbackStats, nps, paymentsSummary, formatMoney, toCsv };
