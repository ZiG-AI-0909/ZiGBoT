import shared from '@/lib/shared';
import { handler, json, readJson, HttpError } from '@/lib/http';
import { requireGuildAdmin } from '@/lib/auth';
import { getChannels } from '@/lib/discord';
import { createServiceClient } from '@/lib/supabase/server';

const { validateAntiNukeSettings, sanitizeAntiNukeSettings, requiredPermissions, ANTINUKE_RULES, THRESHOLD_LIMITS, CONTAINMENT_OPTIONS, ANTINUKE_LIMITS } = shared;

export const dynamic = 'force-dynamic';

// Anti-Nuke is free for every server: no plan check anywhere in this route.
// Reads and writes go through the service role only after the live admin
// check, and every query is pinned to the verified guild id.

// The bot reports status every 10 minutes; older than this is shown as unknown.
const STATUS_STALE_MS = 30 * 60_000;
const SEND_TYPES = new Set([0, 5]); // text, announcement

function meta() {
    return {
        rules: Object.fromEntries(Object.entries(ANTINUKE_RULES).map(([key, rule]) => [key, { severity: rule.severity, title: rule.title }])),
        thresholds: THRESHOLD_LIMITS,
        containment: CONTAINMENT_OPTIONS,
        limits: ANTINUKE_LIMITS
    };
}

function statusView(row, now) {
    if (!row) return { known: false, reason: 'ZiGBoT has not reported for this server yet. It reports within 10 minutes of starting.' };
    const checked = Date.parse(row.last_checked_at || '');
    const fresh = Number.isFinite(checked) && now - checked < STATUS_STALE_MS;
    return {
        known: fresh,
        reason: fresh ? null : 'ZiGBoT has not reported recently (the bot may be offline), so the protection status is unknown.',
        monitoring: Boolean(row.monitoring),
        missingPermissions: row.missing_permissions || [],
        alertChannelOk: Boolean(row.alert_channel_ok),
        lastEventAt: row.last_event_at,
        lastCheckedAt: row.last_checked_at
    };
}

async function load(db, guildId) {
    const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const [settings, status, recent, openCritical] = await Promise.all([
        db.from('zb_security_settings').select('*').eq('guild_id', guildId).maybeSingle(),
        db.from('zb_security_status').select('*').eq('guild_id', guildId).maybeSingle(),
        db.from('zb_security_events').select('id', { count: 'exact', head: true }).eq('guild_id', guildId).gte('created_at', since),
        db.from('zb_security_events').select('id', { count: 'exact', head: true }).eq('guild_id', guildId).eq('severity', 'CRITICAL').eq('status', 'open')
    ]);
    for (const result of [settings, status, recent, openCritical]) {
        if (result.error) throw new Error(`Anti-Nuke read failed: ${result.error.message}`);
    }
    const value = sanitizeAntiNukeSettings(settings.data, guildId);
    return {
        settings: value,
        status: statusView(status.data, Date.now()),
        required: requiredPermissions(value).map(({ name, why, baseline }) => ({ name, why, baseline })),
        summary: { incidents7d: recent.count || 0, openCritical: openCritical.count || 0 },
        meta: meta()
    };
}

// GET: settings, live status, summary counts for THIS server.
export const GET = handler(async (_request, { params }) => {
    const { guildId } = await params;
    const { guild } = await requireGuildAdmin(guildId);
    return json(await load(createServiceClient(), String(guild.id)));
});

// PUT: save alert + containment settings. Validated against this server's
// live channels and roles; there is no field that turns monitoring off.
export const PUT = handler(async (request, { params }) => {
    const { guildId } = await params;
    const { guild, user, discordId } = await requireGuildAdmin(guildId);
    const body = await readJson(request);
    const channels = await getChannels(guild.id);
    const channelIds = new Set(channels.filter((c) => SEND_TYPES.has(c.type)).map((c) => String(c.id)));
    const roleIds = new Set((guild.roles || []).filter((r) => String(r.id) !== String(guild.id)).map((r) => String(r.id)));
    const result = validateAntiNukeSettings(body?.settings, { channelIds, roleIds, guildId: String(guild.id) });
    if (!result.ok) throw new HttpError(422, 'Some settings need fixing.', { fieldErrors: result.errors });

    const db = createServiceClient();
    const { data: before } = await db.from('zb_security_settings').select('*').eq('guild_id', String(guild.id)).maybeSingle();
    const { error } = await db.from('zb_security_settings').upsert({
        ...result.value,
        guild_id: String(guild.id),
        updated_by_discord_id: discordId,
        updated_at: new Date().toISOString()
    }, { onConflict: 'guild_id' });
    if (error) {
        const failure = new Error(`Anti-Nuke settings save failed: ${error.message}`);
        if (/relation|schema cache|does not exist/i.test(error.message || '')) {
            failure.publicMessage = 'The database is missing the Anti-Nuke tables. Run supabase/migrations/20261029000000_zigbot_antinuke.sql in the Supabase SQL Editor, then save again.';
        }
        throw failure;
    }
    await db.from('zb_config_audit_log').insert({
        guild_id: String(guild.id),
        actor_user_id: user.id,
        actor_role: 'authenticated',
        action: before ? 'UPDATE' : 'INSERT',
        table_name: 'zb_security_settings',
        record_key: String(guild.id),
        before: before || null,
        after: result.value
    }).then(({ error: auditError }) => auditError && console.error('[antinuke] audit write failed:', auditError.message));
    return json(await load(db, String(guild.id)));
});
