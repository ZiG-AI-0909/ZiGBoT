/**
 * Voice chat panel: posted when ZiGBoT joins a voice channel, with buttons
 * instead of typed commands — start/stop listening, status, leave. Buttons
 * run the normal tool actions for the clicking member, so the usual rules
 * apply (start/stop listening are owner/admin-only because they control
 * recording; voice is a Premium feature).
 */
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags } = require('discord.js');
const { isListening } = require('./voiceConversation');

const PREFIX = 'zigvoice:';
const BUTTON_ACTIONS = {
    listen: 'start_voice_listening',
    mute: 'stop_voice_listening',
    status: 'voice_status',
    leave: 'leave_voice'
};

/** Message payload for the panel; `note` is the line shown above it. */
function buildVoicePanel(guild, note = '') {
    const channel = guild?.members?.me?.voice?.channel || null;
    if (!channel) {
        return {
            content: note || null,
            embeds: [new EmbedBuilder().setColor(0x6b7280).setDescription('🔇 **Not in a voice channel.** Join one and use `/join` to call me.')],
            components: [],
            allowedMentions: { parse: [] }
        };
    }
    const listening = isListening(guild.id);
    const embed = new EmbedBuilder()
        .setColor(0xa855f7)
        .setAuthor({ name: '🎙️ ZiGBoT Voice Chat' })
        .setDescription([
            `Connected to <#${channel.id}>.`,
            listening
                ? '🟢 **Listening** — just talk, I reply out loud.'
                : '⚪ **Not listening** — press **Start listening** to talk with me.',
            '💬 Or type in this voice channel\'s chat — I answer out loud too.',
            '🎵 Want music? Use `/play <song>`.'
        ].join('\n'))
        .setFooter({ text: 'Start/Stop listening: server owner & admins only (it controls recording).' });
    const row = new ActionRowBuilder().addComponents(
        listening
            ? new ButtonBuilder().setCustomId(`${PREFIX}mute`).setLabel('Stop listening').setEmoji('🔇').setStyle(ButtonStyle.Secondary)
            : new ButtonBuilder().setCustomId(`${PREFIX}listen`).setLabel('Start listening').setEmoji('🎙️').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`${PREFIX}status`).setLabel('Status').setEmoji('📊').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`${PREFIX}leave`).setLabel('Leave').setEmoji('👋').setStyle(ButtonStyle.Danger)
    );
    return { content: note || null, embeds: [embed], components: [row], allowedMentions: { parse: [] } };
}

function isVoiceComponent(interaction) {
    return interaction.isButton?.() && String(interaction.customId || '').startsWith(PREFIX);
}

/** runIntent(intent) runs the action for the clicking member and returns the reply text. */
async function handleVoiceComponent(interaction, runIntent) {
    const action = BUTTON_ACTIONS[interaction.customId.slice(PREFIX.length)];
    const privately = (content) => interaction.followUp({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } }).catch(() => {});
    if (!action || !interaction.guild) return;
    await interaction.deferUpdate().catch(() => {});
    const result = String(await runIntent({ action }) || '');
    // The panel always shows the real state after the press.
    await interaction.editReply(buildVoicePanel(interaction.guild)).catch(() => {});
    if (action === 'voice_status' || /^(❌|💎|⚠️|🎧|🔒|⛔|🚫)/u.test(result)) await privately(result);
}

module.exports = { buildVoicePanel, isVoiceComponent, handleVoiceComponent, PREFIX };
