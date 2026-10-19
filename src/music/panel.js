/**
 * Music control panel: one message per server with the current song and
 * buttons (pause/resume, skip, stop, loop, volume, queue). It is posted in the
 * channel where /play was used, follows player events, and turns into a
 * "finished" card (buttons disabled) when the music stops.
 *
 * Buttons only control playback; they go through the same executeTool path
 * as typed commands (premium + per-role feature checks), and only members in
 * the bot's voice channel may press them.
 */
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags } = require('discord.js');
const music = require('./player');

const PREFIX = 'zigmusic:';
const COLOR = 0xa855f7;
const VOLUME_STEP = 10;
const panels = new Map(); // guildId -> { channel, message }

// Button id -> how to run it.
const BUTTON_ACTIONS = {
    pause: () => ({ action: 'pause_music' }),
    resume: () => ({ action: 'resume_music' }),
    skip: () => ({ action: 'skip_music' }),
    stop: () => ({ action: 'stop_music' }),
    loop: () => ({ action: 'loop_music' }),
    voldown: (q) => ({ action: 'volume_music', volume: Math.max(0, q.volume - VOLUME_STEP) }),
    volup: (q) => ({ action: 'volume_music', volume: Math.min(100, q.volume + VOLUME_STEP) })
};

function trackLink(track) {
    if (!track) return 'Nothing';
    const title = String(track.title || track.url).replace(/[[\]]/g, '');
    return track.title ? `[${title}](${track.url})` : track.url;
}

function upNextLines(tracks, limit) {
    const lines = tracks.slice(0, limit).map((t, i) => {
        const length = music.formatDuration(t.duration);
        return `\`${i + 1}.\` ${String(t.title || t.url).slice(0, 70)}${length ? ` · ${length}` : ''}`;
    });
    if (tracks.length > limit) lines.push(`…and ${tracks.length - limit} more`);
    return lines;
}

function buttons(q, disabled = false) {
    const button = (id, label, emoji, style = ButtonStyle.Secondary) => new ButtonBuilder()
        .setCustomId(PREFIX + id).setLabel(label).setEmoji(emoji).setStyle(style).setDisabled(disabled);
    return [
        new ActionRowBuilder().addComponents(
            q.paused ? button('resume', 'Resume', '▶️', ButtonStyle.Success) : button('pause', 'Pause', '⏸️', ButtonStyle.Primary),
            button('skip', 'Skip', '⏭️'),
            button('stop', 'Stop', '⏹️', ButtonStyle.Danger),
            button('loop', q.loop ? 'Loop: On' : 'Loop: Off', '🔁', q.loop ? ButtonStyle.Success : ButtonStyle.Secondary)
        ),
        new ActionRowBuilder().addComponents(
            button('voldown', 'Vol -', '🔉').setDisabled(disabled || q.volume <= 0),
            button('volup', 'Vol +', '🔊').setDisabled(disabled || q.volume >= 100),
            button('queue', `Queue (${q.tracks.length})`, '📜')
        )
    ];
}

/** Message payload for the live panel. */
function buildPanel(guildId) {
    const q = music.queue(guildId);
    const track = q.current;
    const length = music.formatDuration(track?.duration);
    const embed = new EmbedBuilder()
        .setColor(COLOR)
        .setAuthor({ name: q.paused ? '⏸️ Paused' : '🎶 Now Playing' })
        .setDescription(`### ${trackLink(track)}`)
        .addFields(
            { name: 'Length', value: length || 'Unknown', inline: true },
            { name: 'Requested by', value: track?.requestedBy ? `<@${track.requestedBy}>` : 'Unknown', inline: true },
            { name: 'Volume', value: `${q.volume}%`, inline: true }
        );
    if (track?.source === 'youtube') {
        const id = new URL(track.url).searchParams.get('v');
        if (id) embed.setThumbnail(`https://i.ytimg.com/vi/${id}/mqdefault.jpg`);
    }
    const next = upNextLines(q.tracks, 5);
    embed.addFields({ name: 'Up next', value: next.length ? next.join('\n') : 'Nothing queued — use `/play` to add songs.' });
    embed.setFooter({ text: 'Only listeners in my voice channel can use these buttons.' });
    return { embeds: [embed], components: buttons(q), allowedMentions: { parse: [] } };
}

function finishedPayload(reason) {
    const embed = new EmbedBuilder()
        .setColor(0x6b7280)
        .setDescription(reason === 'stopped' ? '⏹️ **Music stopped.** Use `/play` to start again.' : '✅ **Queue finished.** Use `/play` to add more songs.');
    return { embeds: [embed], components: [], allowedMentions: { parse: [] } };
}

async function postOrEdit(guildId, channel) {
    const existing = panels.get(guildId);
    const payload = buildPanel(guildId);
    const target = channel || existing?.channel;
    if (!target) return;
    // A new song in a different channel, or the old panel is gone: post a fresh one.
    if (existing?.message && existing.channel?.id === target.id) {
        try {
            await existing.message.edit(payload);
            return;
        } catch {
            // Deleted or not editable any more: fall through and post again.
        }
    }
    if (existing?.message && existing.channel?.id !== target.id) {
        existing.message.edit(finishedPayload('moved')).catch(() => {});
    }
    const message = await target.send(payload);
    panels.set(guildId, { channel: target, message });
}

function safely(promise) {
    Promise.resolve(promise).catch((error) => console.error(`[ZiGBoT MUSIC] panel update failed: ${error.message}`));
}

music.events.on('trackStart', (guildId, track) => safely(postOrEdit(guildId, track?.channel || null)));
music.events.on('queueChanged', (guildId) => {
    if (panels.has(guildId) && music.queue(guildId).current) safely(postOrEdit(guildId, null));
});
music.events.on('finished', (guildId, reason) => {
    const panel = panels.get(guildId);
    panels.delete(guildId);
    if (panel?.message) safely(panel.message.edit(finishedPayload(reason)));
});

function isMusicButton(interaction) {
    return interaction.isButton?.() && String(interaction.customId || '').startsWith(PREFIX);
}

/**
 * Handle a panel button. `runIntent(intent)` executes a music intent for the
 * clicking member (with all the normal checks) and returns the result text.
 */
async function handleMusicButton(interaction, runIntent) {
    const id = interaction.customId.slice(PREFIX.length);
    const guild = interaction.guild;
    const ephemeral = (content) => interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } }).catch(() => {});
    if (!guild) return;

    const botChannelId = guild.members.me?.voice?.channelId;
    if (!botChannelId) return ephemeral('🔇 I am not playing anything right now. Use `/play` to start.');
    if (interaction.member?.voice?.channelId !== botChannelId) {
        return ephemeral(`🎧 Join <#${botChannelId}> to control the music.`);
    }

    const q = music.queue(guild.id);
    if (id === 'queue') {
        const lines = upNextLines(q.tracks, 15);
        return ephemeral([
            `🎵 **Now playing:** ${q.current ? music.describeTrack(q.current) : 'nothing'}${q.loop ? ' 🔁' : ''}`,
            lines.length ? `**Up next:**\n${lines.join('\n')}` : 'Nothing else queued.'
        ].join('\n'));
    }

    const build = BUTTON_ACTIONS[id];
    if (!build) return ephemeral('❌ Unknown button.');
    await interaction.deferUpdate().catch(() => {});
    const result = String(await runIntent(build(q)) || '');
    // Successful presses update the panel via player events; only problems get a private note.
    if (/^(❌|💎)/u.test(result)) {
        await interaction.followUp({ content: result, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } }).catch(() => {});
    }
}

module.exports = { isMusicButton, handleMusicButton, buildPanel, BUTTON_ACTIONS, PREFIX };
