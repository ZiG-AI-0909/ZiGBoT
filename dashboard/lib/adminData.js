import 'server-only';
import shared from './shared';
import stats from './shared/adminStats';
import { createServiceClient } from './supabase/server';
import { listPayments } from './razorpay';
import { getGuildWithCounts } from './discord';
import { env } from './env';

// Super Admin data. Every loader reads real rows (service role, called only
// after requireSuperAdmin/getSuperAdmin) and reports a missing source as
// unavailable with the reason, instead of inventing a value.

const { isPremiumActive, ANTINUKE_RULES } = shared;
export const PAGE_SIZE = 25;
const SCAN_MAX = 2000; // upper bound for rows aggregated in one view

const db = () => createServiceClient();
const range = (page) => {
    const p = Math.max(1, Number.parseInt(page, 10) || 1);
    return { page: p, from: (p - 1) * PAGE_SIZE, to: p * PAGE_SIZE - 1 };
};
const unavailable = (reason) => ({ available: false, reason });

async function rows(query, what) {
    const { data, error } = await query;
    if (error) {
        console.error(`[admin] ${what} failed:`, error.message);
        return { data: null, error: /relation|does not exist|schema cache/i.test(error.message) ? `The ${what} table is missing (migration not run).` : `Could not load ${what}.` };
    }
    return { data: data || [], error: null };
}

async function count(query, what) {
    const { count: n, error } = await query;
    if (error) {
        console.error(`[admin] ${what} count failed:`, error.message);
        return null;
    }
    return n ?? 0;
}

/** Captured/pending/failed payments straight from Razorpay, or why they are unavailable. */
export async function loadPayments() {
    if (!env.billingEnabled) return { ...unavailable('Razorpay is not configured on this dashboard (RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET / plans).'), items: [] };
    try {
        const items = await listPayments({ max: 300 });
        return { available: true, items, summary: stats.paymentsSummary(items), limited: items.length >= 300 };
    } catch (error) {
        return { ...unavailable(error?.publicMessage || 'Razorpay could not be reached.'), items: [] };
    }
}

export async function loadOverview() {
    const service = db();
    const [users, guilds, subs, purchases, feedback, critical, heartbeat, profiles, purchaseRows, feedbackRows, events, payments] = await Promise.all([
        count(service.from('zb_profiles').select('user_id', { count: 'exact', head: true }), 'users'),
        count(service.from('zb_guilds').select('guild_id', { count: 'exact', head: true }).eq('bot_installed', true).is('removed_at', null), 'servers'),
        rows(service.from('zb_guild_subscriptions').select('status, current_period_end, plan_period'), 'subscriptions'),
        count(service.from('zb_premium_purchases').select('id', { count: 'exact', head: true }), 'purchases'),
        count(service.from('zb_premium_feedback').select('id', { count: 'exact', head: true }), 'feedback'),
        count(service.from('zb_security_events').select('id', { count: 'exact', head: true }).eq('severity', 'CRITICAL').eq('status', 'open'), 'critical incidents'),
        rows(service.from('zb_bot_heartbeat').select('last_seen_at, guild_count, version').eq('id', 'main'), 'bot heartbeat'),
        rows(service.from('zb_profiles').select('created_at').order('created_at', { ascending: false }).limit(SCAN_MAX), 'users'),
        rows(service.from('zb_premium_purchases').select('verified_at, plan_period').order('verified_at', { ascending: false }).limit(SCAN_MAX), 'purchases'),
        rows(service.from('zb_premium_feedback').select('overall_rating, activation_ease, recommend_score, plan_period, review_status, archived_at').limit(SCAN_MAX), 'feedback'),
        rows(service.from('zb_security_events').select('created_at, severity').order('created_at', { ascending: false }).limit(SCAN_MAX), 'security incidents'),
        loadPayments()
    ]);
    const beat = heartbeat.data?.[0] || null;
    const beatAge = beat ? Date.now() - Date.parse(beat.last_seen_at) : null;
    const feedbackStats = feedbackRows.data ? stats.feedbackStats(feedbackRows.data) : null;
    const captured = (payments.items || []).filter((p) => p.status === 'captured' || p.status === 'refunded');
    return {
        cards: {
            users,
            servers: guilds,
            activePremium: subs.data ? subs.data.filter((s) => isPremiumActive(s)).length : null,
            purchases,
            feedback,
            avgSatisfaction: feedbackStats?.all.avgRating ?? null,
            openCritical: critical,
            revenue: payments.available ? stats.formatMoney(payments.summary.collectedPaise, payments.summary.currency) : null
        },
        payments,
        health: {
            bot: beat ? { lastSeenAt: beat.last_seen_at, guildCount: beat.guild_count, version: beat.version, stale: beatAge > 5 * 60_000 } : null,
            errorsTracked: false
        },
        charts: {
            users: profiles.data ? stats.monthlySeries(profiles.data, { date: (r) => r.created_at }) : null,
            purchases: purchaseRows.data ? stats.monthlySeries(purchaseRows.data, { date: (r) => r.verified_at }) : null,
            revenue: payments.available ? stats.monthlySeries(captured, { date: (p) => p.created_at * 1000, value: (p) => ((Number(p.amount) || 0) - (Number(p.amount_refunded) || 0)) / 100 }) : null,
            plans: purchaseRows.data ? [
                { key: 'monthly', label: 'Monthly (₹399)', value: purchaseRows.data.filter((p) => p.plan_period === 'monthly').length },
                { key: 'yearly', label: 'Yearly (₹3,999)', value: purchaseRows.data.filter((p) => p.plan_period === 'yearly').length }
            ] : null,
            ratings: feedbackStats?.ratingDistribution ?? null,
            incidents: events.data ? stats.monthlySeries(events.data, { date: (r) => r.created_at }) : null
        }
    };
}

export async function loadUsers({ q = '', page = 1 } = {}) {
    const { page: p, from, to } = range(page);
    let query = db().from('zb_profiles').select('user_id, discord_user_id, username, avatar_url, created_at', { count: 'exact' });
    const term = String(q).trim().slice(0, 100);
    if (/^\d{17,20}$/.test(term)) query = query.eq('discord_user_id', term);
    else if (term) query = query.ilike('username', `%${term.replace(/[%_\\]/g, (c) => `\\${c}`)}%`);
    const { data, error, count: total } = await query.order('created_at', { ascending: false }).range(from, to);
    if (error) return { users: [], total: 0, page: p, error: 'Could not load users.' };
    const ids = (data || []).map((u) => u.user_id);
    const { data: bought } = ids.length ? await db().from('zb_premium_purchases').select('user_id, plan_period, verified_at').in('user_id', ids) : { data: [] };
    return {
        page: p,
        total: total || 0,
        users: (data || []).map((u) => ({ ...u, purchases: (bought || []).filter((b) => b.user_id === u.user_id) }))
    };
}

export async function loadUserDetail(userId) {
    if (!/^[0-9a-f-]{36}$/i.test(String(userId || ''))) return null;
    const service = db();
    const { data: profile } = await service.from('zb_profiles').select('*').eq('user_id', userId).maybeSingle();
    if (!profile) return null;
    const [auth, purchases, feedback, guilds] = await Promise.all([
        service.auth.admin.getUserById(userId).then((r) => r.data?.user || null, () => null),
        rows(service.from('zb_premium_purchases').select('id, subscription_id, guild_id, plan_period, amount_paise, currency, verified_at, is_first_purchase, feedback_state').eq('user_id', userId).order('verified_at', { ascending: false }), 'purchases'),
        rows(service.from('zb_premium_feedback').select('id, plan_period, overall_rating, recommend_score, submitted_at, review_status').eq('user_id', userId), 'feedback'),
        rows(service.from('zb_user_guilds').select('guild_id, name, can_manage, fetched_at').eq('user_id', userId).order('name'), 'servers')
    ]);
    return {
        profile,
        // Only non-secret account facts: no tokens, no provider data blobs.
        account: auth ? { createdAt: auth.created_at, lastSignInAt: auth.last_sign_in_at, provider: auth.app_metadata?.provider || null } : null,
        purchases,
        feedback,
        guilds
    };
}

export async function loadServers({ q = '', page = 1 } = {}) {
    const { page: p, from, to } = range(page);
    let query = db().from('zb_guilds').select('guild_id, name, owner_discord_id, bot_installed, installed_at, removed_at', { count: 'exact' });
    const term = String(q).trim().slice(0, 100);
    if (/^\d{17,20}$/.test(term)) query = query.eq('guild_id', term);
    else if (term) query = query.ilike('name', `%${term.replace(/[%_\\]/g, (c) => `\\${c}`)}%`);
    const { data, error, count: total } = await query.order('installed_at', { ascending: false, nullsFirst: false }).range(from, to);
    if (error) return { servers: [], total: 0, page: p, error: 'Could not load servers.' };
    const ids = (data || []).map((g) => g.guild_id);
    const service = db();
    const [subs, status, settings, open] = ids.length ? await Promise.all([
        service.from('zb_guild_subscriptions').select('guild_id, status, plan_period, current_period_end').in('guild_id', ids),
        service.from('zb_security_status').select('guild_id, monitoring, missing_permissions, alert_channel_ok, last_checked_at').in('guild_id', ids),
        service.from('zb_security_settings').select('guild_id, alert_channel_id').in('guild_id', ids),
        service.from('zb_security_events').select('guild_id, severity').in('guild_id', ids).eq('status', 'open')
    ]) : [{ data: [] }, { data: [] }, { data: [] }, { data: [] }];
    const by = (list, id) => (list.data || []).find((r) => r.guild_id === id) || null;
    return {
        page: p,
        total: total || 0,
        servers: (data || []).map((g) => {
            const sub = by(subs, g.guild_id);
            return {
                ...g,
                premium: sub ? { active: isPremiumActive(sub), status: sub.status, period: sub.plan_period } : null,
                security: by(status, g.guild_id),
                alertChannelId: by(settings, g.guild_id)?.alert_channel_id || null,
                openIncidents: (open.data || []).filter((e) => e.guild_id === g.guild_id).length
            };
        })
    };
}

export async function loadServerDetail(guildId) {
    if (!/^\d{17,20}$/.test(String(guildId || ''))) return null;
    const service = db();
    const { data: guild } = await service.from('zb_guilds').select('*').eq('guild_id', guildId).maybeSingle();
    if (!guild) return null;
    const [live, sub, status, settings, incidents] = await Promise.all([
        getGuildWithCounts(guildId).catch(() => null),
        service.from('zb_guild_subscriptions').select('status, plan_period, current_period_end, cancel_at_period_end, subscription_id').eq('guild_id', guildId).maybeSingle(),
        service.from('zb_security_status').select('*').eq('guild_id', guildId).maybeSingle(),
        service.from('zb_security_settings').select('alert_channel_id, notify_owner, staff_role_id, containment').eq('guild_id', guildId).maybeSingle(),
        rows(service.from('zb_security_events').select('id, rule, severity, actor_id, resource_count, containment_status, status, created_at').eq('guild_id', guildId).order('id', { ascending: false }).limit(20), 'incidents')
    ]);
    return {
        guild,
        live: live ? { name: live.name, members: live.approximate_member_count ?? null, online: live.approximate_presence_count ?? null } : null,
        subscription: sub.data ? { ...sub.data, active: isPremiumActive(sub.data) } : null,
        security: status.data || null,
        settings: settings.data || null,
        incidents: incidents.data ? incidents.data.map((e) => ({ ...e, title: ANTINUKE_RULES[e.rule]?.title || e.rule })) : null,
        incidentsError: incidents.error
    };
}

export async function loadPremium({ page = 1 } = {}) {
    const { page: p, from, to } = range(page);
    const service = db();
    const [purchases, subs, payments] = await Promise.all([
        service.from('zb_premium_purchases').select('id, subscription_id, guild_id, user_id, discord_user_id, plan_period, amount_paise, currency, verified_at, is_first_purchase', { count: 'exact' }).order('verified_at', { ascending: false }).range(from, to),
        rows(service.from('zb_guild_subscriptions').select('guild_id, subscription_id, plan_period, status, current_period_end, cancel_at_period_end, pending_subscription_id'), 'subscriptions'),
        loadPayments()
    ]);
    const userIds = [...new Set((purchases.data || []).map((x) => x.user_id).filter(Boolean))];
    const { data: profiles } = userIds.length ? await service.from('zb_profiles').select('user_id, username').in('user_id', userIds) : { data: [] };
    const names = new Map((profiles || []).map((x) => [x.user_id, x.username]));
    return {
        page: p,
        total: purchases.count || 0,
        purchasesError: purchases.error ? 'Could not load purchases (has the feedback migration been run?).' : null,
        purchases: (purchases.data || []).map((x) => ({ ...x, username: names.get(x.user_id) || null })),
        subscriptions: subs,
        payments
    };
}

/**
 * A query builder for feedback with the admin's filters applied in the
 * database. null = the search matched no user (an empty result).
 * Search: a Discord user ID directly, otherwise usernames -> account ids.
 */
async function feedbackQuery({ plan = '', status = '', rating = '', from: fromDate = '', to: toDate = '', q = '', issue = '', archived = '' } = {}) {
    const term = String(q).trim().slice(0, 100);
    let userIds = null;
    if (term && !/^\d{17,20}$/.test(term)) {
        const { data: matches } = await db().from('zb_profiles').select('user_id').ilike('username', `%${term.replace(/[%_\\]/g, (c) => `\\${c}`)}%`).limit(200);
        userIds = (matches || []).map((m) => m.user_id);
        if (userIds.length === 0) return null;
    }
    return (columns, opts) => {
        let query = db().from('zb_premium_feedback').select(columns, opts);
        if (plan === 'monthly' || plan === 'yearly') query = query.eq('plan_period', plan);
        if (status === 'new' || status === 'reviewed') query = query.eq('review_status', status);
        if (/^[1-5]$/.test(String(rating))) query = query.eq('overall_rating', Number(rating));
        if (/^\d{4}-\d{2}-\d{2}$/.test(fromDate)) query = query.gte('submitted_at', `${fromDate}T00:00:00Z`);
        if (/^\d{4}-\d{2}-\d{2}$/.test(toDate)) query = query.lte('submitted_at', `${toDate}T23:59:59Z`);
        if (/^[a-z_]{2,30}$/.test(issue)) query = query.contains('issues', [issue]);
        if (/^\d{17,20}$/.test(term)) query = query.eq('discord_user_id', term);
        if (userIds) query = query.in('user_id', userIds);
        return archived === 'only' ? query.not('archived_at', 'is', null) : archived === 'all' ? query : query.is('archived_at', null);
    };
}

async function withUsernames(list) {
    const ids = [...new Set((list || []).map((r) => r.user_id).filter(Boolean))];
    const { data: profiles } = ids.length ? await db().from('zb_profiles').select('user_id, username').in('user_id', ids) : { data: [] };
    const names = new Map((profiles || []).map((x) => [x.user_id, x.username]));
    return (list || []).map((r) => ({ ...r, username: names.get(r.user_id) || null }));
}

/** Every matching response (up to the export cap), newest first, in one query. */
export async function exportFeedbackRows(filters = {}) {
    const build = await feedbackQuery(filters);
    if (!build) return [];
    const { data, error } = await build('*').order('submitted_at', { ascending: filters.sort === 'oldest' }).limit(SCAN_MAX);
    if (error) throw new Error('Could not load feedback.');
    return withUsernames(data);
}

/** Feedback list (filters applied in the database) plus stats over ALL matching rows. */
export async function loadFeedback(filters = {}) {
    const { page: p, from, to } = range(filters.page);
    const build = await feedbackQuery(filters);
    if (!build) return { page: p, total: 0, responses: [], stats: stats.feedbackStats([]), trend: null };
    const sort = filters.sort;
    const [list, all] = await Promise.all([
        build('*', { count: 'exact' }).order('submitted_at', { ascending: sort === 'oldest' }).range(from, to),
        rows(build('*').limit(SCAN_MAX), 'feedback')
    ]);
    if (list.error) return { error: 'Could not load feedback (has the feedback migration been run?).', responses: [], total: 0, page: p, stats: null };
    return {
        page: p,
        total: list.count || 0,
        responses: await withUsernames(list.data),
        stats: all.data ? stats.feedbackStats(all.data) : null,
        trend: all.data ? stats.monthlySeries(all.data, { date: (r) => r.submitted_at }) : null
    };
}

export async function loadFeedbackDetail(id) {
    if (!/^[0-9a-f-]{36}$/i.test(String(id || ''))) return null;
    const service = db();
    const { data } = await service.from('zb_premium_feedback').select('*').eq('id', id).maybeSingle();
    if (!data) return null;
    const [{ data: profile }, { data: purchase }] = await Promise.all([
        data.user_id ? service.from('zb_profiles').select('username, discord_user_id').eq('user_id', data.user_id).maybeSingle() : { data: null },
        service.from('zb_premium_purchases').select('subscription_id, guild_id, verified_at, amount_paise, currency, plan_period').eq('id', data.purchase_id).maybeSingle()
    ]);
    return { response: data, profile, purchase };
}

export async function loadSecurity({ severity = '', status = 'open', page = 1 } = {}) {
    const { page: p, from, to } = range(page);
    const service = db();
    let events = service.from('zb_security_events').select('id, guild_id, rule, severity, actor_id, actor_is_bot, resource_count, occurrences, reason, containment_status, containment_actions, alert_status, status, created_at', { count: 'exact' });
    if (['CRITICAL', 'HIGH', 'MEDIUM'].includes(severity)) events = events.eq('severity', severity);
    if (['open', 'acknowledged', 'resolved'].includes(status)) events = events.eq('status', status);
    const [list, statuses] = await Promise.all([
        events.order('id', { ascending: false }).range(from, to),
        rows(service.from('zb_security_status').select('guild_id, monitoring, missing_permissions, alert_channel_ok, last_checked_at, last_event_at'), 'security status')
    ]);
    const ids = [...new Set([...(list.data || []).map((e) => e.guild_id), ...(statuses.data || []).map((s) => s.guild_id)])];
    const { data: guilds } = ids.length ? await service.from('zb_guilds').select('guild_id, name').in('guild_id', ids) : { data: [] };
    const names = new Map((guilds || []).map((g) => [g.guild_id, g.name]));
    const staleAfter = Date.now() - 30 * 60_000;
    return {
        page: p,
        total: list.count || 0,
        error: list.error ? 'Could not load incidents (has the Anti-Nuke migration been run?).' : null,
        events: (list.data || []).map((e) => ({ ...e, guild_name: names.get(e.guild_id) || e.guild_id, title: ANTINUKE_RULES[e.rule]?.title || e.rule, steps: ANTINUKE_RULES[e.rule]?.steps || [] })),
        coverage: statuses.data ? {
            total: statuses.data.length,
            monitoring: statuses.data.filter((s) => s.monitoring && Date.parse(s.last_checked_at) > staleAfter).length,
            gaps: statuses.data
                .filter((s) => !s.monitoring || (s.missing_permissions || []).length > 0 || !s.alert_channel_ok || Date.parse(s.last_checked_at) <= staleAfter)
                .map((s) => ({ ...s, guild_name: names.get(s.guild_id) || s.guild_id, stale: Date.parse(s.last_checked_at) <= staleAfter }))
        } : null,
        coverageError: statuses.error
    };
}

export async function loadAudit({ page = 1 } = {}) {
    const { page: p, from, to } = range(page);
    const { data, error, count: total } = await db().from('zb_admin_audit_log').select('*', { count: 'exact' }).order('id', { ascending: false }).range(from, to);
    return { page: p, total: total || 0, entries: data || [], error: error ? 'Could not load the admin audit log (has the admin migration been run?).' : null };
}

export function adminConfig() {
    return {
        adminCount: env.superAdminDiscordIds.length,
        billingEnabled: env.billingEnabled,
        webhookEnabled: env.webhookEnabled,
        customIdentityEnabled: env.customIdentityEnabled,
        botCreatorSet: /^\d{17,20}$/.test(env.botCreatorId)
    };
}
