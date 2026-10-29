/**
 * Anti-Nuke monitor: wires Discord events to the detection engine,
 * containment, storage and alerts. Free and always on: there is no switch
 * that stops monitoring or alerts; only containment is optional.
 *
 * Events come from Discord's live audit-log stream (GuildAuditLogEntryCreate:
 * needs the GuildModeration intent and View Audit Log) plus member joins.
 * Each server has its own bounded queue processed in order, so a burst of
 * hundreds of events never blocks the bot or other servers; past the bound,
 * events are dropped and counted (the incident they belong to has already
 * fired by then).
 *
 * Detection state (rolling windows) is in memory and starts empty after a
 * restart; incidents, settings and status are persisted.
 */
const { ChannelType, PermissionFlagsBits } = require('discord.js');
const { createEngine, normalizeAuditEntry, joinEvent } = require('./engine');
const { runContainment } = require('./containment');
const { buildAlert } = require('./alerts');
const { missingPermissions } = require('../../dashboard/lib/shared/antinuke');

const ALERT_CHANNEL_NAME = 'zigbot-security';
const QUEUE_MAX = 500;
const STATUS_INTERVAL_MS = 10 * 60_000;
const PURGE_INTERVAL_MS = 24 * 60 * 60_000;
const ALERTS_PER_WINDOW = 10;
const ALERT_WINDOW_MS = 10 * 60_000;
const LAST_EVENT_WRITE_MS = 60_000;
const code = (error) => String(error?.code || error?.status || error?.name || 'Error').slice(0, 40);

function createAntiNuke({ client, store, engine = createEngine(), logger = console, now = () => Date.now(), dashboardUrl = () => '', version = '', queueMax = QUEUE_MAX }) {
    const queues = new Map();
    const alertTimes = new Map();
    const lastEventWrite = new Map();
    let dropped = 0;
    const log = (message) => logger.log?.(`[ZiGBoT ANTINUKE] ${message}`);
    const warn = (message) => logger.error?.(`[ZiGBoT ANTINUKE] ${message}`);

    /** Run fn after earlier work for the same server; bounded. Returns false when dropped. */
    function enqueue(guildId, fn) {
        const queue = queues.get(guildId) || { chain: Promise.resolve(), size: 0 };
        if (queue.size >= queueMax) {
            dropped += 1;
            if (dropped === 1 || dropped % 100 === 0) warn(`Event queue full for ${guildId}; dropped ${dropped} event(s) so far.`);
            return false;
        }
        queue.size += 1;
        queue.chain = queue.chain
            .then(fn)
            .catch((error) => warn(`Processing failed in ${guildId}: ${code(error)}`))
            .finally(() => {
                queue.size -= 1;
            });
        queues.set(guildId, queue);
        return queue.chain;
    }

    function allowAlert(guildId) {
        const t = now();
        const recent = (alertTimes.get(guildId) || []).filter((at) => t - at < ALERT_WINDOW_MS);
        if (recent.length >= ALERTS_PER_WINDOW) {
            alertTimes.set(guildId, recent);
            return false;
        }
        recent.push(t);
        alertTimes.set(guildId, recent);
        return true;
    }

    function alertChannel(guild, settings) {
        const byId = settings.alert_channel_id ? guild.channels?.cache?.get(settings.alert_channel_id) : null;
        const channel = byId || guild.channels?.cache?.find?.((c) => c.name === ALERT_CHANNEL_NAME && c.type === ChannelType.GuildText) || null;
        const me = guild.members?.me;
        if (!channel || !me || !channel.isTextBased?.()) return null;
        const perms = channel.permissionsFor?.(me);
        return perms?.has?.([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]) ? channel : null;
    }

    /** 'sent' | 'dm' | 'failed' | 'held' */
    async function deliver(guild, settings, alert) {
        if (!allowAlert(guild.id)) return 'held';
        const channel = alertChannel(guild, settings);
        if (channel) {
            try {
                await channel.send({ content: alert.content, allowedMentions: alert.allowedMentions });
                return 'sent';
            } catch (error) {
                warn(`Alert to the channel failed in ${guild.id}: ${code(error)}`);
            }
        }
        if (settings.notify_owner) {
            try {
                const owner = await guild.fetchOwner();
                await owner.send({ content: `${alert.content.slice(0, 1800)}\n\n_(Sent to you because ZiGBoT could not post in a security alert channel in this server. Pick one in the dashboard's Anti-Nuke tab.)_`, allowedMentions: { parse: [] } });
                return 'dm';
            } catch (error) {
                warn(`Alert DM to the owner failed in ${guild.id}: ${code(error)}`);
            }
        }
        return 'failed';
    }

    async function handleIncident(incident, guild, settings) {
        if (incident.delivery === 'suppressed') {
            if (incident.incidentId) await store.bumpOccurrences(guild.id, incident.incidentId).catch(() => {});
            return { delivered: 'suppressed' };
        }
        const containment = await runContainment({ incident, guild, settings });
        let row = null;
        try {
            row = await store.recordIncident({
                guild_id: guild.id,
                rule: incident.rule,
                severity: incident.severity,
                actor_id: incident.actorId,
                actor_is_bot: Boolean(incident.actorIsBot),
                target_ids: (incident.targetIds || []).slice(0, 50),
                resource_count: Number(incident.count) || 0,
                reason: String(incident.reason || '').slice(0, 500),
                evidence: { delivery: incident.delivery, permissions: incident.permissions || [], bot_id: incident.botId || null },
                containment_status: containment.status,
                containment_actions: containment.actions
            });
        } catch (error) {
            warn(`Saving an incident failed in ${guild.id}: ${code(error)}`);
        }
        engine.linkIncident(guild.id, incident.dedupeKey, row?.id ?? null);
        const alert = buildAlert({ incident, guild, settings, containment, dashboardUrl: dashboardUrl(guild.id), when: now() });
        const delivered = await deliver(guild, settings, alert);
        if (row?.id) await store.updateIncident(guild.id, row.id, { alert_status: delivered }).catch(() => {});
        log(`${incident.severity} ${incident.rule} in ${guild.id}${incident.actorId ? ` by ${incident.actorId}` : ''}: alert ${delivered}, containment ${containment.status}.`);
        return { delivered, containment, row };
    }

    function noteEvent(guildId) {
        const t = now();
        if (t - (lastEventWrite.get(guildId) || 0) < LAST_EVENT_WRITE_MS) return;
        lastEventWrite.set(guildId, t);
        store.upsertStatus(guildId, { last_event_at: new Date(t).toISOString() }).catch(() => {});
    }

    async function processAuditEntry(entry, guild) {
        noteEvent(guild.id);
        const event = normalizeAuditEntry(entry, {
            rolePermissions: (roleId) => guild.roles?.cache?.get(roleId)?.permissions?.bitfield ?? 0n,
            now: now()
        });
        if (!event) return [];
        const settings = await store.getSettings(guild.id);
        const ctx = { guildId: guild.id, ownerId: guild.ownerId, botId: client.user?.id };
        if (event.type === 'bot_add' && event.targetId) {
            const added = await guild.members.fetch(event.targetId).catch(() => null);
            ctx.botPermissions = added?.permissions?.bitfield ?? 0n;
        }
        const actorIsBot = Boolean(entry.executor?.bot);
        const results = [];
        for (const incident of engine.process(event, settings, ctx)) {
            results.push(await handleIncident({ ...incident, actorIsBot }, guild, settings));
        }
        return results;
    }

    async function processJoin(member) {
        const guild = member.guild;
        const settings = await store.getSettings(guild.id);
        const results = [];
        for (const incident of engine.process(joinEvent(member, now()), settings, { guildId: guild.id, ownerId: guild.ownerId, botId: client.user?.id })) {
            results.push(await handleIncident(incident, guild, settings));
        }
        return results;
    }

    /** What ZiGBoT can actually see and do here, reported for the dashboard. */
    async function reportStatus(guild) {
        const settings = await store.getSettings(guild.id);
        const bits = guild.members?.me?.permissions?.bitfield ?? 0n;
        const missing = missingPermissions(bits, settings);
        const status = {
            monitoring: !missing.some((p) => p.name === 'View Audit Log'),
            missing_permissions: missing.map((p) => p.name),
            alert_channel_ok: Boolean(alertChannel(guild, settings)),
            last_checked_at: new Date(now()).toISOString(),
            bot_version: String(version || '').slice(0, 40) || null
        };
        await store.upsertStatus(guild.id, status).catch((error) => warn(`Status update failed in ${guild.id}: ${code(error)}`));
        return status;
    }

    /**
     * A server ZiGBoT just joined: default settings, a private
     * #zigbot-security channel when allowed, and a status report. Baseline
     * monitoring needs nothing else; it is on from the first event.
     */
    async function setupNewGuild(guild) {
        await store.ensureSettings(guild.id).catch((error) => warn(`Settings seed failed in ${guild.id}: ${code(error)}`));
        const settings = await store.getSettings(guild.id);
        const me = guild.members?.me;
        if (!alertChannel(guild, settings) && me?.permissions?.has?.(PermissionFlagsBits.ManageChannels)) {
            try {
                const channel = await guild.channels.create({
                    name: ALERT_CHANNEL_NAME,
                    type: ChannelType.GuildText,
                    topic: 'ZiGBoT Anti-Nuke security alerts. Only admins can see this channel.',
                    reason: 'ZiGBoT Anti-Nuke: private security alert channel',
                    permissionOverwrites: [
                        { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
                        { id: me.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] }
                    ]
                });
                await store.setAlertChannelIfUnset(guild.id, channel.id).catch(() => {});
                await channel.send({
                    content: '🛡️ **ZiGBoT Anti-Nuke is on** (free, for every server).\nSecurity alerts land here. Only the owner and admins can see this channel; change who sees it, or pick another channel, any time.\nZiGBoT watches the audit log for mass deletions, mass bans/kicks, dangerous permission grants, risky bot additions, webhook bursts and join raids. It alerts with clear next steps; automatic containment is off until an admin turns it on in the dashboard.',
                    allowedMentions: { parse: [] }
                });
            } catch (error) {
                warn(`Could not create the alert channel in ${guild.id}: ${code(error)}`);
            }
        }
        return reportStatus(guild);
    }

    function onAuditLogEntry(entry, guild) {
        if (!guild?.id) return false;
        return enqueue(guild.id, () => processAuditEntry(entry, guild));
    }

    function onMemberAdd(member) {
        if (!member?.guild?.id) return false;
        return enqueue(member.guild.id, () => processJoin(member));
    }

    function onGuildRemoved(guildId) {
        engine.forget(guildId);
        queues.delete(String(guildId));
        alertTimes.delete(String(guildId));
    }

    let timers = [];
    async function reportAll() {
        for (const guild of client.guilds.cache.values()) await reportStatus(guild).catch(() => {});
    }
    function start() {
        void reportAll();
        void store.purgeOld().catch(() => {});
        timers = [setInterval(reportAll, STATUS_INTERVAL_MS), setInterval(() => store.purgeOld().catch(() => {}), PURGE_INTERVAL_MS)];
        for (const timer of timers) timer.unref?.();
        log(`Monitoring ${client.guilds.cache.size} server(s) (free, always on; containment per server setting).`);
    }

    return { onAuditLogEntry, onMemberAdd, onGuildRemoved, setupNewGuild, reportStatus, processAuditEntry, processJoin, handleIncident, start, enqueue, _queues: queues, get dropped() { return dropped; } };
}

module.exports = { createAntiNuke, ALERT_CHANNEL_NAME, ALERTS_PER_WINDOW, QUEUE_MAX };
