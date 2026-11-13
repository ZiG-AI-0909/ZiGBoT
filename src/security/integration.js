const { PermissionFlagsBits, AuditLogEvent } = require('discord.js');
const { createSecurityEventProcessor } = require('./core/processor');
const { detectRaidSignals } = require('./detectors/raidDetector');
const { AiSecurityAssistant } = require('./intelligence/assistant');
const { auditSecurityEvent } = require('./audit/logger');
const { canQuarantineMessage } = require('./response/responseEngine');

const MESSAGE_PATTERN_WINDOW_MS = 60_000;
const MAX_MESSAGE_PATTERNS_PER_GUILD = 200;

function normalizeUrls(content = '') {
  if (!content || typeof content !== 'string') return [];
  const regex = /(https?:\/\/[^\s]+|www\.[^\s]+)/gi;
  return [...content.matchAll(regex)].map((match) => match[0]);
}

function canDeleteMessage(message) {
  return canQuarantineMessage(message);
}

function canAlert(guild) {
  if (!guild) return false;
  const me = guild.members?.me || guild.me;
  if (!me) return false;
  return Boolean(me.permissions?.has?.(PermissionFlagsBits.ViewAuditLog) || me.permissions?.has?.(PermissionFlagsBits.ManageMessages));
}

function createSecurityIntegration({
  settings = {},
  antiNuke = null,
  auditLog,
  logger = console,
  processor = null,
  aiClient = null,
  aiModel = null,
  securityAssistant = null,
  now = () => Date.now()
} = {}) {
  const securitySettings = { securityEnabled: true, ...settings };
  const eventProcessor = processor || createSecurityEventProcessor({
    serverPolicy: {
      quarantineEnabled: true,
      moderatorNotifyThreshold: 40,
      emergencyLockdownThreshold: 80,
      notifyOwner: true
    }
  });
  const assistant = securityAssistant || new AiSecurityAssistant({
    client: aiClient,
    model: aiModel,
    rateLimitMax: settings.securityAiRateLimitMax || 8,
    rateLimitWindowMs: (settings.securityAiRateLimitWindowSeconds || 60) * 1000,
    logger,
    now
  });
  const recentJoins = new Map();
  const recentMessagePatterns = new Map();

  function recordRepeatedMessage(guildId, userId, content, timestamp) {
    const normalized = String(content || '').trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 1000);
    if (!normalized || !userId) return { count: 0, newRaidSignal: false };

    const patterns = recentMessagePatterns.get(guildId) || new Map();
    const cutoff = timestamp - MESSAGE_PATTERN_WINDOW_MS;
    for (const [pattern, state] of patterns) {
      if (state.lastAt <= cutoff) patterns.delete(pattern);
    }

    const state = patterns.get(normalized) || { users: new Set(), lastAt: timestamp };
    const previousCount = state.users.size;
    if (state.users.size < 10) state.users.add(String(userId));
    state.lastAt = timestamp;
    patterns.delete(normalized);
    patterns.set(normalized, state);
    while (patterns.size > MAX_MESSAGE_PATTERNS_PER_GUILD) {
      patterns.delete(patterns.keys().next().value);
    }
    recentMessagePatterns.set(guildId, patterns);

    return {
      count: state.users.size,
      newRaidSignal: previousCount < 3 && state.users.size >= 3
    };
  }

  async function logAudit(message, result, details = {}) {
    try {
      await auditSecurityEvent({
        message,
        settings: securitySettings,
        event: 'SECURITY_INTEGRATION',
        action: result?.policyDecision?.action || 'security_check',
        target: message?.author?.id || message?.id || 'unknown',
        result: 'logged',
        details: { score: result?.score, label: result?.label, ...details }
      }, { auditLog });
    } catch (error) {
      logger.error?.(`[ZiGBoT SECURITY] audit log fallback failed: ${error?.message || error}`);
    }
  }

  async function notifyModerators(guild, message, result) {
    if (!guild || !canAlert(guild)) return false;
    const content = `[ZiGBoT SECURITY] ${result?.label || 'Suspicious'} activity: score ${result?.score || 0}. ${result?.evidence?.join('; ') || 'No evidence reported.'}`;
    try {
      if (guild.owner?.send) {
        await guild.owner.send({ content, allowedMentions: { parse: [] } }).catch(() => {});
      }
      const securityChannel = guild.channels?.cache?.find?.((channel) => channel.name === 'zigbot-security' && channel.isTextBased?.());
      if (securityChannel?.send) {
        await securityChannel.send({ content, allowedMentions: { parse: [] } }).catch(() => {});
      }
      return true;
    } catch (error) {
      logger.error?.(`[ZiGBoT SECURITY] moderator alert failed: ${error?.message || error}`);
      return false;
    }
  }

  async function quarantineMessage(message) {
    if (!message || !canDeleteMessage(message)) return false;
    try {
      await message.delete();
      return true;
    } catch (error) {
      logger.error?.(`[ZiGBoT SECURITY] quarantine failed: ${error?.message || error}`);
      return false;
    }
  }

  async function evaluateMessage(message) {
    if (!securitySettings.securityEnabled || message?.author?.bot || !message?.guild) return;
    const content = String(message.content || '');
    const timestamp = now();
    const repeatedMessage = recordRepeatedMessage(message.guild.id, message.author.id, content, timestamp);
    const joinRate = (recentJoins.get(message.guild.id) || [])
      .filter((joinedAt) => timestamp - joinedAt <= MESSAGE_PATTERN_WINDOW_MS).length;
    const urls = normalizeUrls(content);
    const result = eventProcessor.processEvent({
      guildId: message.guild.id,
      userId: message.author.id,
      message: content,
      urls,
      messageCount: 1,
      mentionCount: message.mentions?.users?.size || 0,
      repeatedMessages: repeatedMessage.count,
      moderationEvasion: 0,
      accountAgeMs: message.author?.createdTimestamp ? timestamp - Number(message.author.createdTimestamp) : 0,
      joinRate,
      accountAgeVariance: joinRate >= 5 ? 1 : 0,
      suspiciousDmActivity: 0,
      confidence: 0.82
    });

    if (repeatedMessage.newRaidSignal && result?.raidSignals?.score >= 30) {
      const raidResult = {
        score: result.raidSignals.score,
        label: result.raidSignals.score >= 60 ? 'Severe' : 'High Risk',
        evidence: result.raidSignals.evidence,
        policyDecision: { action: 'notify_moderators' },
        response: { actions: ['notify_moderators', 'log_security_event'] }
      };
      await notifyModerators(message.guild, message, raidResult);
      await logAudit(message, raidResult, {
        raidSignal: true,
        joinRate,
        repeatedMessagePattern: repeatedMessage.count
      });
    }

    if (!result || result.label === 'Normal' || result.score < 20) return;

    const action = result?.policyDecision?.action;
    const shouldQuarantine = action === 'quarantine' || action === 'emergency_lockdown';
    const shouldAlert = ['notify_moderators', 'quarantine', 'monitor', 'emergency_lockdown'].includes(action);

    if (shouldQuarantine) {
      const didDelete = await quarantineMessage(message);
      await logAudit(message, result, { quarantine: didDelete, action: 'quarantine' });
    }

    if (shouldAlert) {
      await notifyModerators(message.guild, message, result);
      await logAudit(message, result, { alertSent: true });
    }
  }

  async function evaluateGuildMemberAdd(member) {
    if (!securitySettings.securityEnabled || !member?.guild) return;
    const guildId = member.guild.id;
    const snapshots = recentJoins.get(guildId) || [];
    const nowTs = now();
    const filtered = snapshots.filter((ts) => nowTs - ts <= 60_000);
    filtered.push(nowTs);
    recentJoins.set(guildId, filtered);

    const joinRate = filtered.length;
    if (joinRate < 5) return;
    const raid = detectRaidSignals({ joinRate, mentionBurst: 0, repeatedMessagePattern: 0, invitationPattern: 0, accountAgeVariance: 1 });
    if (raid.score < 30) return;

    const message = { guild: member.guild, author: { id: member.user?.id || 'unknown', bot: false }, id: `raid-${guildId}-${nowTs}` };
    const result = {
      score: raid.score,
      label: raid.score >= 60 ? 'Severe' : 'High Risk',
      policyDecision: { action: 'notify_moderators' },
      evidence: raid.evidence,
      response: { actions: ['notify_moderators', 'log_security_event'] }
    };
    await notifyModerators(member.guild, message, result);
    await logAudit(message, result, { raidSignal: true, joinRate });
  }

  async function emitAuditCorrelatedEvent(guild, eventName, targetId) {
    if (!securitySettings.securityEnabled || !guild || !antiNuke) return;
    const actionMap = {
      channelDelete: AuditLogEvent.ChannelDelete,
      roleDelete: AuditLogEvent.RoleDelete,
      guildBanAdd: AuditLogEvent.MemberBanAdd,
      webhookUpdate: AuditLogEvent.WebhookUpdate
    };
    const action = actionMap[eventName];
    if (!action) return;
    if (typeof guild.fetchAuditLogs !== 'function') {
      logger.error?.(`[ZiGBoT SECURITY] cannot correlate ${eventName}: audit-log fetch unavailable.`);
      return;
    }

    try {
      const auditLogs = await guild.fetchAuditLogs({ type: action, limit: 10 });
      const entries = Array.from(auditLogs?.entries?.values?.() || []);
      const correlated = entries.find((entry) => {
        if (entry?.action !== action) return false;
        const createdAt = Number(entry.createdTimestamp) || entry.createdAt?.getTime?.();
        const age = now() - createdAt;
        if (!Number.isFinite(age) || age < -1000 || age > 15_000) return false;
        const entryTarget = eventName === 'webhookUpdate'
          ? entry.extra?.channel?.id || entry.extra?.channelId
          : entry.targetId;
        return String(entryTarget || '') === String(targetId || '');
      });

      if (correlated) return antiNuke.onAuditLogEntry(correlated, guild);
    } catch (error) {
      logger.error?.(`[ZiGBoT SECURITY] ${eventName} audit-log correlation failed: ${error?.message || error}`);
    }
  }

  return {
    evaluateMessage,
    evaluateGuildMemberAdd,
    emitAuditCorrelatedEvent,
    quarantineMessage,
    notifyModerators,
    securitySettings,
    securityAssistant: assistant,
    getIncidents: (guildId) => eventProcessor.incidentManager?.getGuildIncidents?.(guildId) || []
  };
}

module.exports = { createSecurityIntegration, normalizeUrls, canDeleteMessage, canAlert };
