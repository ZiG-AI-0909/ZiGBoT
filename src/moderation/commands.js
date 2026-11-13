const { PermissionFlagsBits } = require('discord.js');

function createModerationCommands({ store, getGuildConfig, auditLog } = {}) {
  if (!store || typeof getGuildConfig !== 'function') {
    throw new TypeError('Moderation commands require a store and guild config resolver');
  }

  async function reply(interaction, content) {
    await interaction.reply({ content, ephemeral: true, allowedMentions: { parse: [] } });
  }

  async function guildConfig(interaction) {
    return getGuildConfig(interaction.guild);
  }

  async function writeAudit(interaction, config, action, target, result, details = {}) {
    if (typeof auditLog !== 'function') return;
    await auditLog({
      message: { author: interaction.user, guild: interaction.guild, channel: interaction.channel, client: interaction.client },
      settings: { logChannelId: config?.log_channel_id || '' },
      event: 'MODERATION',
      action,
      target,
      result,
      details
    });
  }

  async function handleAppeal(interaction) {
    if (!interaction.guildId || !interaction.guild) return reply(interaction, 'Appeals can only be submitted inside a server.');
    const config = await guildConfig(interaction);
    if (config?.moderation_appeals_enabled !== true) {
      return reply(interaction, 'Appeals are disabled for this server. Ask a server moderator to enable them.');
    }

    const caseId = interaction.options.getString('case');
    const reason = interaction.options.getString('reason');
    if (!/^\d{1,12}$/.test(String(caseId || '')) || !reason?.trim()) {
      return reply(interaction, 'Provide a valid case number and an appeal reason.');
    }

    try {
      const appeal = await store.createModerationAppeal(interaction.guildId, caseId, interaction.user.id, reason.trim());
      await writeAudit(interaction, config, 'appeal_submit', `case-${caseId}`, 'SUBMITTED', { appealId: appeal.id });
      return reply(interaction, `Your appeal #${appeal.id} for case #${caseId} was submitted for moderator review.`);
    } catch (error) {
      return reply(interaction, `Appeal was not submitted: ${error.message}`);
    }
  }

  async function handleModeration(interaction) {
    if (!interaction.guildId || !interaction.guild) return reply(interaction, 'Moderation tools can only be used inside a server.');
    const allowed = interaction.memberPermissions?.has?.(PermissionFlagsBits.Administrator)
      || interaction.memberPermissions?.has?.(PermissionFlagsBits.ModerateMembers);
    if (!allowed) return reply(interaction, 'You need Administrator or Moderate Members permission to use this command.');

    const config = await guildConfig(interaction);
    const subcommand = interaction.options.getSubcommand();
    try {
      if (subcommand === 'logs') {
        const cases = await store.listModerationCases(interaction.guildId, 10);
        const lines = cases.map((entry) => `#${entry.id} ${entry.action} — ${entry.target} (<t:${Math.floor(entry.created_at / 1000)}:R>)`);
        return reply(interaction, lines.length ? lines.join('\n') : 'No moderation cases are recorded for this server.');
      }

      if (subcommand === 'case') {
        const caseId = interaction.options.getString('case');
        const entry = await store.getModerationCase(interaction.guildId, caseId);
        if (!entry) return reply(interaction, 'That moderation case was not found in this server.');
        return reply(interaction, `Case #${entry.id}: ${entry.action}; target ${entry.target}; moderator <@${entry.actorId}>; reason: ${entry.reason || 'none'}; result: ${entry.result}.`);
      }

      if (subcommand === 'review') {
        if (config?.moderation_appeals_enabled !== true) return reply(interaction, 'Appeals are disabled for this server.');
        const appealId = interaction.options.getString('appeal');
        const decision = interaction.options.getString('decision');
        const note = interaction.options.getString('note') || '';
        const reviewed = await store.reviewModerationAppeal(
          interaction.guildId,
          appealId,
          interaction.user.id,
          decision === 'approve' ? 'approved' : 'rejected',
          note
        );
        if (!reviewed) return reply(interaction, 'No pending appeal with that ID was found in this server.');
        await writeAudit(interaction, config, 'appeal_review', `appeal-${appealId}`, 'REVIEWED', { decision, note: note.slice(0, 200) });
        return reply(interaction, `Appeal #${appealId} reviewed as ${decision}. No punishment was automatically changed.`);
      }

      return reply(interaction, 'Unsupported moderation subcommand.');
    } catch (error) {
      return reply(interaction, `Moderation request failed: ${error.message}`);
    }
  }

  return { handleAppeal, handleModeration };
}

module.exports = { createModerationCommands };
