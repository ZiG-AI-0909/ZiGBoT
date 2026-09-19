const crypto = require('node:crypto');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { auditLog } = require('../logging/auditLog');

function isConfirmationActor(message, settings, userId) {
    if (!userId || userId !== message.author?.id) return false;
    const { isAuthorizedActor } = require('../tools/router');
    return isAuthorizedActor({ author: { id: userId }, member: message.member, guild: message.guild }, settings).allowed;
}

function requestConfirmation(message, settings, intent, execute) {
    const id = crypto.randomBytes(8).toString('hex');
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`zig_confirm_${id}`).setLabel('Confirm').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`zig_cancel_${id}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary)
    );

    return message.reply({
        content: `⚠️ This action is destructive: **${intent.action}**${intent.target ? ` on **${intent.target}**` : ''}.\nOnly the requesting owner or an authorized admin can confirm it. This request expires in 45 seconds.`,
        components: [row]
    }).then(async (confirmationMessage) => {
        await auditLog({ message, settings, event: 'CONFIRMATION REQUEST', action: intent.action, target: intent.target, result: 'PENDING' });
        const collector = confirmationMessage.createMessageComponentCollector({ time: 45000 });

        collector.on('collect', async (interaction) => {
            // Clicker must be the original requester AND an authorized actor
            // (verified owner, per-guild owner, or configured admin role).
            if (!isConfirmationActor(message, settings, interaction.user.id)) {
                await interaction.reply({ content: '❌ Only the requesting owner or an authorized admin may confirm this action.', ephemeral: true });
                return;
            }

            collector.stop('handled');
            if (interaction.customId.startsWith('zig_cancel_')) {
                await auditLog({ message, settings, event: 'CONFIRMATION CANCELLATION', action: intent.action, target: intent.target, result: 'CANCELLED' });
                await interaction.update({ content: '❌ Action cancelled.', components: [] });
                return;
            }

            await interaction.update({ content: '⏳ Processing confirmed action...', components: [] });
            const result = await execute();
            await confirmationMessage.edit({ content: result, components: [] }).catch(() => {});
        });

        collector.on('end', async (_, reason) => {
            if (reason === 'time') {
                await auditLog({ message, settings, event: 'CONFIRMATION EXPIRY', action: intent.action, target: intent.target, result: 'EXPIRED' });
                await confirmationMessage.edit({ content: '⌛ Confirmation expired. No action was taken.', components: [] }).catch(() => {});
            }
        });
    });
}

module.exports = { requestConfirmation };
