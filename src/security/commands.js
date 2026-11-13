const { PermissionFlagsBits } = require('discord.js');

function isSecurityCommandAuthorized(interaction, roleId) {
  const isAdministrator = Boolean(
    interaction?.memberPermissions?.has?.(PermissionFlagsBits.Administrator)
    || interaction?.member?.permissions?.has?.(PermissionFlagsBits.Administrator)
  );
  const roles = interaction?.member?.roles?.cache || interaction?.roles?.cache;
  const hasConfiguredRole = Boolean(roleId && (roles?.has?.(roleId) || roles?.get?.(roleId)));
  return isAdministrator || hasConfiguredRole;
}

function summarizeIncidents(incidents) {
  const byLabel = {};
  const byAction = {};
  for (const incident of incidents) {
    byLabel[incident.label] = (byLabel[incident.label] || 0) + 1;
    const action = incident.policyDecision?.action || 'unknown';
    byAction[action] = (byAction[action] || 0) + 1;
  }
  return { total: incidents.length, byLabel, byAction };
}

function formatAnalysis(analysis) {
  if (!analysis) return '';
  const findings = analysis.findings.length ? ` Findings: ${analysis.findings.join('; ')}` : '';
  return `\nAI summary (advisory): ${analysis.summary}${findings}`;
}

function createSecurityCommands({
  settings = {},
  integration,
  auditLog = async () => {},
  logger = console
} = {}) {
  async function audit(interaction, result, details = {}) {
    try {
      await auditLog({
        message: {
          author: interaction.user,
          member: interaction.member,
          guild: interaction.guild,
          channel: interaction.channel,
          client: interaction.client
        },
        settings,
        event: 'SECURITY',
        action: 'command_access',
        target: interaction.commandName || 'security',
        result,
        details
      });
    } catch (error) {
      logger.error?.(`[ZiGBoT SECURITY] command audit failed: ${error?.message || error}`);
    }
  }

  async function sendPrivate(interaction, content) {
    const payload = { content, ephemeral: true, allowedMentions: { parse: [] } };
    if (interaction.deferred || interaction.replied) {
      return interaction.editReply(payload);
    }
    return interaction.reply(payload);
  }

  async function handleSlash(interaction) {
    const guildId = interaction?.guildId || interaction?.guild?.id;
    if (!guildId) {
      await sendPrivate(interaction, 'The security command is only available in a server.');
      return { authorized: false, reason: 'guild_required' };
    }

    if (!isSecurityCommandAuthorized(interaction, settings.securityAdminRoleId)) {
      await audit(interaction, 'DENIED', { reason: 'Administrator or configured security role required.' });
      await sendPrivate(interaction, 'You need Administrator or the configured security role to use this command.');
      return { authorized: false, reason: 'permission_denied' };
    }

    await audit(interaction, 'SUCCESS', { subcommand: interaction.options.getSubcommand() });
    await interaction.deferReply({ ephemeral: true });

    const subcommand = interaction.options.getSubcommand();
    const incidents = integration?.getIncidents?.(guildId) || [];
    if (subcommand === 'status') {
      const state = settings.securityEnabled === false ? 'disabled' : 'enabled';
      return interaction.editReply({
        content: `Security monitoring is ${state}. ${incidents.length} incident(s) recorded in this server since startup.`,
        allowedMentions: { parse: [] }
      });
    }

    if (subcommand === 'report') {
      const summary = summarizeIncidents(incidents);
      if (!incidents.length) {
        return interaction.editReply({
          content: 'No security incidents have been recorded in this server since startup.',
          allowedMentions: { parse: [] }
        });
      }

      const aiAnalysis = await integration.securityAssistant?.analyze?.({
        guildId,
        untrustedData: {
          report: summary,
          incidents: incidents.slice(-10).map((incident) => ({
            label: incident.label,
            score: incident.score,
            evidence: incident.evidence,
            action: incident.policyDecision?.action || 'unknown'
          }))
        }
      });
      const counts = Object.entries(summary.byLabel).map(([label, count]) => `${label}: ${count}`).join(', ');
      return interaction.editReply({
        content: `Security report: ${summary.total} incident(s). ${counts}.${formatAnalysis(aiAnalysis)}`,
        allowedMentions: { parse: [] }
      });
    }

    if (subcommand === 'why') {
      const target = interaction.options.getUser('user', true);
      const targetIncidents = incidents.filter((incident) => incident.userId === target.id);
      if (!targetIncidents.length) {
        return interaction.editReply({
          content: `No security incidents for ${target.username || 'that user'} in this server.`,
          allowedMentions: { parse: [] }
        });
      }
      const latest = targetIncidents[targetIncidents.length - 1];
      const explanation = integration.securityAssistant?.explainWhyFlagged({
        score: latest.score,
        evidence: latest.evidence
      });
      const aiAnalysis = await integration.securityAssistant?.analyze?.({
        guildId,
        untrustedData: {
          target: target.id,
          incidents: targetIncidents.slice(-10).map((incident) => ({
            label: incident.label,
            score: incident.score,
            evidence: incident.evidence,
            action: incident.policyDecision?.action || 'unknown'
          }))
        }
      });
      const evidence = latest.evidence?.length ? latest.evidence.join('; ') : 'No detailed evidence recorded.';
      return interaction.editReply({
        content: `Latest finding for ${target.username || 'that user'}: ${latest.label} (${latest.score}/100). ${evidence} ${explanation?.explanation || ''}${formatAnalysis(aiAnalysis)}`,
        allowedMentions: { parse: [] }
      });
    }

    return interaction.editReply({ content: 'Unsupported security subcommand.', allowedMentions: { parse: [] } });
  }

  return { handleSlash, isSecurityCommandAuthorized: (interaction) => isSecurityCommandAuthorized(interaction, settings.securityAdminRoleId) };
}

module.exports = { createSecurityCommands, isSecurityCommandAuthorized, summarizeIncidents };
