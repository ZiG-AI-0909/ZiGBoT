/**
 * Anti-Nuke detection engine. Pure: no Discord calls, an injectable clock,
 * so every rule is testable. State is per server, in memory, and bounded.
 *
 * Input: normalized events (normalizeAuditEntry / joinEvent). Output:
 * incidents { rule, severity, actorId, count, targetIds, reason, delivery }
 * where delivery is 'new' (alert), 'escalated' (alert: severity went up) or
 * 'suppressed' (same incident inside the cooldown: count it, do not alert).
 *
 * One action is never proof of an attack: destructive rules need a burst
 * inside the rolling window. Trusted accounts, the owner and maintenance
 * mode skip HIGH/MEDIUM rules, but a burst three times the CRITICAL
 * threshold still alerts for them (a trusted account can be compromised).
 */
const { AuditLogEvent } = require('discord.js');
const { ANTINUKE_RULES, SEVERITY_RANK, dangerousPermissionNames, ANTINUKE_BITS, toPermissionBits } = require('../../dashboard/lib/shared/antinuke');

const MAX_EVENTS_PER_ACTOR = 200;
const MAX_ACTORS_PER_GUILD = 500;
const ACTOR_IDLE_MS = 15 * 60_000;
const TRUSTED_CRITICAL_MULTIPLIER = 3;

// Related rules share one alert slot per actor, so a MEDIUM burst that grows
// into a CRITICAL one alerts again (escalation) instead of being suppressed.
const RULE_FAMILY = Object.freeze({
    mod_burst: 'removal', mass_removal: 'removal',
    dangerous_grant: 'grant', admin_grant: 'grant',
    bot_added_elevated: 'bot', bot_added_admin: 'bot',
    mass_delete: 'destroy', permission_then_destroy: 'destroy'
});

const DESTRUCTIVE = new Set(['channel_delete', 'role_delete']);
const REMOVAL = new Set(['member_ban', 'member_kick', 'member_prune']);
const CREATION = new Set(['channel_create', 'role_create']);
const PERMISSION_CHANGE = new Set(['role_permissions', 'channel_permissions', 'permission_grant']);
const WEBHOOK = new Set(['webhook_create', 'webhook_update', 'webhook_delete']);

function addedBits(change) {
    return toPermissionBits(change?.new) & ~toPermissionBits(change?.old);
}

/**
 * One audit-log entry (discord.js GuildAuditLogsEntry or a plain object with
 * action / executorId / targetId / changes / extra) as an event, or null
 * when Anti-Nuke does not care about it.
 * rolePermissions(roleId) -> permission bits of a role in this server.
 */
function normalizeAuditEntry(entry, { rolePermissions = () => 0n, now = Date.now() } = {}) {
    if (!entry) return null;
    const base = {
        actorId: entry.executorId ? String(entry.executorId) : null,
        targetId: entry.targetId ? String(entry.targetId) : null,
        at: Number(entry.createdTimestamp) || now,
        count: 1
    };
    const changes = Array.isArray(entry.changes) ? entry.changes : [];
    const permissionChange = changes.find((c) => c.key === 'permissions');
    switch (entry.action) {
        case AuditLogEvent.ChannelDelete: return { ...base, type: 'channel_delete' };
        case AuditLogEvent.RoleDelete: return { ...base, type: 'role_delete' };
        case AuditLogEvent.ChannelCreate: return { ...base, type: 'channel_create' };
        case AuditLogEvent.RoleCreate: {
            const granted = permissionChange ? addedBits(permissionChange) : 0n;
            return granted && dangerousPermissionNames(granted).length
                ? { ...base, type: 'permission_grant', granted, via: 'new role' }
                : { ...base, type: 'role_create' };
        }
        case AuditLogEvent.RoleUpdate: {
            if (!permissionChange) return null;
            const granted = addedBits(permissionChange);
            return granted && dangerousPermissionNames(granted).length
                ? { ...base, type: 'permission_grant', granted, via: 'role' }
                : { ...base, type: 'role_permissions' };
        }
        case AuditLogEvent.ChannelOverwriteCreate:
        case AuditLogEvent.ChannelOverwriteUpdate:
        case AuditLogEvent.ChannelOverwriteDelete:
            return { ...base, type: 'channel_permissions' };
        case AuditLogEvent.MemberRoleUpdate: {
            const added = changes.find((c) => c.key === '$add');
            const roles = Array.isArray(added?.new) ? added.new : [];
            let granted = 0n;
            for (const role of roles) granted |= toPermissionBits(rolePermissions(String(role.id)));
            if (!granted || !dangerousPermissionNames(granted).length) return null;
            return { ...base, type: 'permission_grant', granted, via: 'member', roleIds: roles.map((r) => String(r.id)) };
        }
        case AuditLogEvent.MemberBanAdd: return { ...base, type: 'member_ban' };
        case AuditLogEvent.MemberKick: return { ...base, type: 'member_kick' };
        case AuditLogEvent.MemberPrune: {
            const removed = Number(entry.extra?.removed) || 0;
            return removed > 0 ? { ...base, type: 'member_prune', count: removed } : null;
        }
        case AuditLogEvent.BotAdd: return { ...base, type: 'bot_add' };
        case AuditLogEvent.WebhookCreate: return { ...base, type: 'webhook_create' };
        case AuditLogEvent.WebhookUpdate: return { ...base, type: 'webhook_update' };
        case AuditLogEvent.WebhookDelete: return { ...base, type: 'webhook_delete' };
        default: return null;
    }
}

/** A member join (joins are counted per server, not per actor). */
function joinEvent(member, now = Date.now()) {
    return { type: 'member_join', actorId: null, targetId: member?.id ? String(member.id) : null, at: now, count: 1 };
}

function createEngine({ now = () => Date.now() } = {}) {
    const guilds = new Map();

    function guildState(guildId) {
        let state = guilds.get(guildId);
        if (!state) {
            state = { actors: new Map(), joins: [], alerts: new Map() };
            guilds.set(guildId, state);
        }
        return state;
    }

    function actorState(state, actorId) {
        let actor = state.actors.get(actorId);
        if (!actor) {
            if (state.actors.size >= MAX_ACTORS_PER_GUILD) {
                // Drop the longest-idle actor to stay bounded.
                let oldest = null;
                for (const [id, a] of state.actors) if (!oldest || a.lastAt < oldest[1].lastAt) oldest = [id, a];
                if (oldest) state.actors.delete(oldest[0]);
            }
            actor = { events: [], lastAt: 0, lastGrantAt: 0 };
            state.actors.set(actorId, actor);
        }
        return actor;
    }

    const sum = (events, types, since) => events.reduce((n, e) => (e.at >= since && types.has(e.type) ? n + e.count : n), 0);
    const targets = (events, types, since) => [...new Set(events.filter((e) => e.at >= since && types.has(e.type) && e.targetId).map((e) => e.targetId))].slice(0, 50);

    function incident(rule, { actorId = null, count = 0, targetIds = [], reason, extra = {} }) {
        return { rule, severity: ANTINUKE_RULES[rule].severity, actorId, count, targetIds, reason, ...extra };
    }

    /**
     * Process one event. ctx: { guildId, ownerId, botId, actorIsBot,
     * botPermissions (bot_add: the added bot's permission bits) }.
     * settings: sanitizeAntiNukeSettings() output.
     */
    function process(event, settings, ctx) {
        if (!event || !ctx?.guildId) return [];
        const t = now();
        const state = guildState(ctx.guildId);
        const th = settings.thresholds;
        const found = [];

        if (event.type === 'member_join') {
            const since = t - th.join_window_seconds * 1000;
            state.joins = state.joins.filter((at) => at >= since);
            state.joins.push(t);
            if (state.joins.length > 1000) state.joins = state.joins.slice(-1000);
            if (state.joins.length >= th.join_burst) {
                found.push(incident('join_burst', { count: state.joins.length, reason: `${state.joins.length} members joined within ${th.join_window_seconds} seconds (threshold ${th.join_burst}).` }));
            }
            return deliver(state, found, settings, t);
        }

        // ZiGBoT's own actions (e.g. containment) and unattributed entries are not judged.
        if (!event.actorId || event.actorId === ctx.botId) return [];
        const maintenance = Date.parse(settings.maintenance_until || '') > t;
        const elevated = event.actorId === ctx.ownerId || settings.trusted_user_ids.includes(event.actorId) || maintenance;
        const criticalScale = elevated ? TRUSTED_CRITICAL_MULTIPLIER : 1;

        const actor = actorState(state, event.actorId);
        // Windows use the engine's own clock (arrival time): audit entries can
        // arrive late or out of order, and one clock keeps the counts consistent.
        actor.events.push({ type: event.type, at: t, count: event.count || 1, targetId: event.targetId });
        if (actor.events.length > MAX_EVENTS_PER_ACTOR) actor.events = actor.events.slice(-MAX_EVENTS_PER_ACTOR);
        actor.lastAt = t;
        const since = t - th.window_seconds * 1000;
        actor.events = actor.events.filter((e) => e.at >= t - Math.max(th.window_seconds * 1000, ACTOR_IDLE_MS));
        const window = actor.events;
        const base = { actorId: event.actorId };

        // CRITICAL: bursts of destruction (the only rules that also apply to elevated accounts).
        const destroyed = sum(window, DESTRUCTIVE, since);
        if (DESTRUCTIVE.has(event.type) && destroyed >= th.mass_delete * criticalScale) {
            found.push(incident('mass_delete', { ...base, count: destroyed, targetIds: targets(window, DESTRUCTIVE, since), reason: `${destroyed} channels/roles deleted by one account within ${th.window_seconds} seconds (threshold ${th.mass_delete * criticalScale}${elevated ? ', raised for a trusted account' : ''}).` }));
        }
        const removed = sum(window, REMOVAL, since);
        if (REMOVAL.has(event.type) && removed >= th.mass_removal * criticalScale) {
            found.push(incident('mass_removal', { ...base, count: removed, targetIds: targets(window, REMOVAL, since), reason: `${removed} members banned, kicked or pruned by one account within ${th.window_seconds} seconds (threshold ${th.mass_removal * criticalScale}${elevated ? ', raised for a trusted account' : ''}).` }));
        }
        if (!elevated && DESTRUCTIVE.has(event.type) && actor.lastGrantAt >= since && destroyed >= 2) {
            found.push(incident('permission_then_destroy', { ...base, count: destroyed, targetIds: targets(window, DESTRUCTIVE, since), reason: `The same account granted dangerous permissions and then deleted ${destroyed} channels/roles within ${th.window_seconds} seconds.` }));
        }
        if (elevated) return deliver(state, found, settings, t);

        // HIGH / MEDIUM.
        if (event.type === 'permission_grant') {
            actor.lastGrantAt = t;
            const names = dangerousPermissionNames(event.granted);
            const admin = (toPermissionBits(event.granted) & ANTINUKE_BITS.ADMINISTRATOR) === ANTINUKE_BITS.ADMINISTRATOR;
            const what = event.via === 'member' ? 'a member was given a role with' : event.via === 'new role' ? 'a new role was created with' : 'a role was given';
            found.push(incident(admin ? 'admin_grant' : 'dangerous_grant', { ...base, count: 1, targetIds: event.targetId ? [event.targetId] : [], reason: `${what[0].toUpperCase()}${what.slice(1)} ${names.join(', ')}.` , extra: { permissions: names } }));
        }
        const created = sum(window, CREATION, since);
        if (CREATION.has(event.type) && created >= th.mass_create) {
            found.push(incident('mass_create', { ...base, count: created, targetIds: targets(window, CREATION, since), reason: `${created} channels/roles created by one account within ${th.window_seconds} seconds (threshold ${th.mass_create}).` }));
        }
        const churn = sum(window, PERMISSION_CHANGE, since);
        if (PERMISSION_CHANGE.has(event.type) && churn >= th.permission_churn) {
            found.push(incident('permission_churn', { ...base, count: churn, targetIds: targets(window, PERMISSION_CHANGE, since), reason: `${churn} role/channel permission changes by one account within ${th.window_seconds} seconds (threshold ${th.permission_churn}).` }));
        }
        const hooks = sum(window, WEBHOOK, since);
        if (WEBHOOK.has(event.type) && hooks >= th.webhook_burst) {
            found.push(incident('webhook_burst', { ...base, count: hooks, targetIds: targets(window, WEBHOOK, since), reason: `${hooks} webhooks created, changed or deleted by one account within ${th.window_seconds} seconds (threshold ${th.webhook_burst}).` }));
        }
        if (REMOVAL.has(event.type) && removed >= th.mod_burst && removed < th.mass_removal) {
            found.push(incident('mod_burst', { ...base, count: removed, targetIds: targets(window, REMOVAL, since), reason: `${removed} bans/kicks by one account within ${th.window_seconds} seconds (threshold ${th.mod_burst}).` }));
        }
        if (event.type === 'bot_add') {
            const names = dangerousPermissionNames(ctx.botPermissions);
            const admin = (toPermissionBits(ctx.botPermissions) & ANTINUKE_BITS.ADMINISTRATOR) === ANTINUKE_BITS.ADMINISTRATOR;
            if (names.length) {
                found.push(incident(admin ? 'bot_added_admin' : 'bot_added_elevated', { ...base, count: 1, targetIds: event.targetId ? [event.targetId] : [], reason: `A bot was added with ${names.join(', ')} by an account that is not the owner or a trusted admin.`, extra: { botId: event.targetId, permissions: names } }));
            }
        }
        return deliver(state, found, settings, t);
    }

    // Duplicate suppression: one alert per rule+actor per cooldown, unless
    // the severity went up. The most severe incident of a batch comes first.
    function deliver(state, found, settings, t) {
        const cooldownMs = settings.cooldown_minutes * 60_000;
        for (const [key, last] of state.alerts) if (t - last.at > cooldownMs) state.alerts.delete(key);
        return found
            .sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity])
            .map((item) => {
                const key = `${RULE_FAMILY[item.rule] || item.rule}:${item.actorId || '-'}`;
                const last = state.alerts.get(key);
                if (last && SEVERITY_RANK[item.severity] <= SEVERITY_RANK[last.severity]) return { ...item, dedupeKey: key, delivery: 'suppressed', incidentId: last.incidentId };
                const delivery = last ? 'escalated' : 'new';
                state.alerts.set(key, { at: t, severity: item.severity, incidentId: null });
                return { ...item, dedupeKey: key, delivery };
            });
    }

    /** Remember which stored incident an alert key belongs to (for suppressed repeats). */
    function linkIncident(guildId, dedupeKey, incidentId) {
        const entry = guilds.get(guildId)?.alerts.get(dedupeKey);
        if (entry) entry.incidentId = incidentId;
    }

    function forget(guildId) {
        guilds.delete(String(guildId));
    }

    return { process, linkIncident, forget, _guilds: guilds };
}

module.exports = { createEngine, normalizeAuditEntry, joinEvent, TRUSTED_CRITICAL_MULTIPLIER };
