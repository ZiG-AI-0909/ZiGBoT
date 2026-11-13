function createSecurityEventHandlers(integration) {
  if (!integration) throw new TypeError('A security integration is required');

  return {
    messageCreate: (message) => integration.evaluateMessage(message),
    guildMemberAdd: (member) => integration.evaluateGuildMemberAdd(member),
    channelDelete: (channel) => integration.emitAuditCorrelatedEvent(channel?.guild, 'channelDelete', channel?.id),
    roleDelete: (role) => integration.emitAuditCorrelatedEvent(role?.guild, 'roleDelete', role?.id),
    guildBanAdd: (ban) => integration.emitAuditCorrelatedEvent(ban?.guild, 'guildBanAdd', ban?.user?.id || ban?.id || null),
    webhookUpdate: (channel) => integration.emitAuditCorrelatedEvent(channel?.guild, 'webhookUpdate', channel?.id || null)
  };
}

module.exports = { createSecurityEventHandlers };
