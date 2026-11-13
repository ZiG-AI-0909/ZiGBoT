/**
 * Analytics (Section L) rows for the dashboard charts and the CSV export.
 * Input: zb_feature_records rows of kind "analytics" (aggregate counts per
 * day; no content, no member ids). CommonJS so the tests can run it.
 */
const { toCsv } = require('./adminStats');

const FIELDS = ['joins', 'leaves', 'messages', 'active', 'moderation', 'security', 'tickets', 'event_participants'];
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** [{ day, joins, ..., topChannels }] oldest first, only valid days, numbers only. */
function analyticsRows(records, { days = 30 } = {}) {
    const n = (v) => (Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
    return (records || [])
        .filter((r) => r && DAY.test(String(r.key)) && r.data && typeof r.data === 'object')
        .sort((a, b) => String(a.key).localeCompare(String(b.key)))
        .slice(-Math.min(Math.max(days, 1), 400))
        .map((r) => {
            const row = { day: r.key };
            for (const field of FIELDS) row[field] = n(r.data[field]);
            row.channels = Object.entries(r.data.channels || {}).filter(([id, v]) => /^\d{17,20}$/.test(id) && Number.isFinite(v)).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([id, v]) => ({ id, messages: n(v) }));
            return row;
        });
}

const COLUMNS = [
    { label: 'Date', get: (r) => r.day },
    { label: 'Joins', get: (r) => r.joins },
    { label: 'Leaves', get: (r) => r.leaves },
    { label: 'Messages', get: (r) => r.messages },
    { label: 'Active members', get: (r) => r.active },
    { label: 'Moderation cases', get: (r) => r.moderation },
    { label: 'Security incidents', get: (r) => r.security },
    { label: 'Tickets opened', get: (r) => r.tickets },
    { label: 'Event participants', get: (r) => r.event_participants },
    { label: 'Top channels (id:messages)', get: (r) => r.channels.map((c) => `${c.id}:${c.messages}`).join(' ') }
];

const analyticsCsv = (rows) => toCsv(rows, COLUMNS);

module.exports = { analyticsRows, analyticsCsv, ANALYTICS_FIELDS: FIELDS };
