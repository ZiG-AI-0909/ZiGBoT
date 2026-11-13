const { PermissionFlagsBits } = require('discord.js');

function buildResponsePlan({ policyDecision = null, serverPolicy = {} } = {}) {
  const decision = policyDecision || { action: 'log_only', severity: 'normal' };
  const actions = [];

  actions.push('log_security_event');
  if (decision.action === 'log_only') {
    return { actions, reason: 'Normal activity only', decision };
  }
  if (decision.action === 'monitor') {
    actions.push('monitor_behaviour');
    return { actions, reason: 'Monitoring and review.', decision };
  }
  if (decision.action === 'notify_moderators') {
    actions.push('notify_moderators');
    actions.push('request_investigation');
    return { actions, reason: 'Moderators should investigate.', decision };
  }
  if (decision.action === 'quarantine') {
    actions.push('notify_moderators');
    actions.push('temporary_restriction');
    return { actions, reason: 'Temporary restriction is recommended.', decision };
  }
  actions.push('notify_moderators');
  actions.push('emergency_lockdown');
  if (serverPolicy.notifyOwner !== false) actions.push('notify_owner');
  return { actions, reason: 'Critical response plan.', decision };
}

function canQuarantineMessage(message) {
  if (!message?.guild || !message.deletable) return false;
  const botMember = message.guild.members?.me || message.guild.me;
  const authorMember = message.member;
  if (!botMember?.permissions?.has?.(PermissionFlagsBits.ManageMessages)) return false;
  if (!botMember.roles?.highest || !authorMember?.roles?.highest) return false;
  const comparison = botMember.roles.highest.comparePositionTo?.(authorMember.roles.highest);
  return Number.isFinite(comparison) && comparison > 0;
}

module.exports = { buildResponsePlan, canQuarantineMessage };
