import { handler, json, HttpError } from '@/lib/http';
import { requireGuildStaff } from '@/lib/auth';
import { createServiceClient } from '@/lib/supabase/server';
import analytics from '@/lib/shared/analyticsExport';
import { loadPlan } from '@/lib/billing';

export const dynamic = 'force-dynamic';

const FREE_DAYS = 7;
const PREMIUM_DAYS = 400;

// GET ?days=30[&format=csv]: THIS guild's daily analytics counts (Section L).
// Admins or read-only dashboard staff (live Discord check, lib/auth.js
// requireGuildStaff); the service-role read is pinned to the verified guild
// id. Counts only: no message content, no member ids.
export const GET = handler(async (request, { params }) => {
    const { guildId } = await params;
    const { guild } = await requireGuildStaff(guildId);
    const url = new URL(request.url);
    // Free servers: the last 7 days. Premium: full history (400 days) and CSV export.
    const { premium } = await loadPlan(guild);
    const maxDays = premium ? PREMIUM_DAYS : FREE_DAYS;
    if (url.searchParams.get('format') === 'csv' && !premium) throw new HttpError(402, 'CSV export is part of ZiGBoT Premium.', { code: 'premium_required' });
    const days = Math.min(Math.max(Number.parseInt(url.searchParams.get('days') || '30', 10) || 30, 1), maxDays);
    const { data, error } = await createServiceClient()
        .from('zb_feature_records')
        .select('guild_id, key, data')
        .eq('guild_id', String(guild.id))
        .eq('kind', 'analytics')
        .order('key', { ascending: false })
        .limit(days);
    if (error) {
        if (/relation|schema cache|does not exist/i.test(error.message || '')) throw new HttpError(503, 'Analytics storage is not set up yet: run the newest files in supabase/migrations.');
        throw new Error(`Analytics read failed: ${error.message}`);
    }
    const rows = analytics.analyticsRows((data || []).filter((r) => String(r.guild_id) === String(guild.id)), { days });
    if (url.searchParams.get('format') === 'csv') {
        return new Response(analytics.analyticsCsv(rows), {
            headers: {
                'Content-Type': 'text/csv; charset=utf-8',
                'Content-Disposition': `attachment; filename="zigbot-analytics-${guild.id}-${new Date().toISOString().slice(0, 10)}.csv"`,
                'Cache-Control': 'no-store'
            }
        });
    }
    return json({ rows, premium, maxDays });
});
