/**
 * Music control panel: one message per server with the current song and
 * buttons (pause/resume, skip, stop, loop, volume, shuffle, queue). It is
 * posted in the channel where the song was requested, follows player events,
 * and turns into a "finished" card (no buttons) when the music stops.
 *
 * Buttons go through the same executeTool path as commands, so premium,
 * per-role features, the DJ role and "be in my voice channel" all apply.
 */
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags } = require('discord.js');
const music = require('./player');
const { SOURCE_LABEL } = require('./sources');
const { isSearchComponent, handleSearchComponent } = require('./search');

const PREFIX = 'zigmusic:';
const COLOR = 0xa855f7;
const VOLUME_STEP = 10;
const LOOP_LABEL = { off: 'Loop: Off', track: 'Loop: Song', queue: 'Loop: Queue' };
const panels = new Map(); // guildId -> { channel, message }

// Button id -> the music intent it runs.
const BUTTON_ACTIONS = {
    pause: () => ({ action: 'pause_music' }),
    resume: () => ({ action: 'resume_music' }),
    skip: () => ({ action: 'skip_music' }),
    stop: () => ({ action: 'stop_music' }),
    loop: () => ({ action: 'loop_music' }),
    shuffle: () => ({ action: 'shuffle_music' }),
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

function buttons(q) {
    const button = (id, label, emoji, style = ButtonStyle.Secondary) => new ButtonBuilder()
        .setCustomId(PREFIX + id).setLabel(label).setEmoji(emoji).setStyle(style);
    return [
        new ActionRowBuilder().addComponents(
            q.paused ? button('resume', 'Resume', '▶️', ButtonStyle.Success) : button('pause', 'Pause', '⏸️', ButtonStyle.Primary),
            button('skip', 'Skip', '⏭️'),
            button('stop', 'Stop', '⏹️', ButtonStyle.Danger),
            button('loop', LOOP_LABEL[q.loop] || LOOP_LABEL.off, q.loop === 'track' ? '🔂' : '🔁', q.loop !== 'off' ? ButtonStyle.Success : ButtonStyle.Secondary)
        ),
        new ActionRowBuilder().addComponents(
            button('voldown', 'Vol -', '🔉').setDisabled(q.volume <= 0),
            button('volup', 'Vol +', '🔊').setDisabled(q.volume >= 100),
            button('shuffle', 'Shuffle', '🔀').setDisabled(q.tracks.length < 2),
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
        .setDescription(`### ${trackLink(track)}${track?.artist ? `\n${track.artist}` : ''}`)
        .addFields(
            { name: 'Length', value: length || 'Unknown', inline: true },
            { name: 'Requested by', value: track?.requestedBy ? `<@${track.requestedBy}>` : 'Unknown', inline: true },
            { name: 'Volume', value: `${q.volume}%`, inline: true }
        );
    if (track?.thumbnail) embed.setThumbnail(track.thumbnail);
    const next = upNextLines(q.tracks, 5);
    embed.addFields({ name: 'Up next', value: next.length ? next.join('\n') : 'Nothing queued — use `/play` to add songs.' });
    const source = SOURCE_LABEL[track?.source] || 'Unknown';
    embed.setFooter({ text: `${source}${track?.fallbackFrom ? ' (YouTube was unavailable)' : ''} · Only listeners in my voice channel can use these buttons.` });
    return { embeds: [embed], components: buttons(q), allowedMentions: { parse: [] } };
}

const FINISHED_TEXT = {
    stopped: '⏹️ **Music stopped.** Use `/play` to start again.',
    left: '👋 **Left the voice channel** after a while with nothing playing or nobody listening. Use `/play` to bring me back.',
    moved: '🎶 The music panel moved to another channel.',
    'queue-end': '✅ **Queue finished.** Use `/play` to add more songs.'
};

function finishedPayload(reason) {
    const embed = new EmbedBuilder().setColor(0x6b7280).setDescription(FINISHED_TEXT[reason] || FINISHED_TEXT['queue-end']);
    return { embeds: [embed], components: [], allowedMentions: { parse: [] } };
}

async function postOrEdit(guildId, channel) {
    const existing = panels.get(guildId);
    if (!music.queue(guildId).current) return;
    const payload = buildPanel(guildId);
    const target = channel || existing?.channel;
    if (!target) return;
    if (existing?.message && existing.channel?.id === target.id) {
        try {
            await existing.message.edit(payload);
            return;
        } catch {
            // Deleted or not editable any more: post a fresh one below.
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

// Several changes in a row (e.g. volume clicks) become one edit.
const pendingEdits = new Map();
function scheduleEdit(guildId) {
    if (pendingEdits.has(guildId)) return;
    pendingEdits.set(guildId, setTimeout(() => {
        pendingEdits.delete(guildId);
        if (panels.has(guildId)) safely(postOrEdit(guildId, null));
    }, 400));
}

music.events.on('trackStart', (guildId, track) => safely(postOrEdit(guildId, track?.channel || null)));
music.events.on('queueChanged', (guildId) => scheduleEdit(guildId));
music.events.on('finished', (guildId, reason) => {
    const panel = panels.get(guildId);
    panels.delete(guildId);
    if (panel?.message) safely(panel.message.edit(finishedPayload(reason)));
});

function isMusicComponent(interaction) {
    return (interaction.isButton?.() || interaction.isStringSelectMenu?.())
        && String(interaction.customId || '').startsWith(PREFIX);
}

/**
 * Handle a panel button or a /search pick. `runIntent(intent)` runs a music
 * intent for the clicking member (all normal checks) and returns the reply.
 */
async function handleMusicComponent(interaction, runIntent) {
    if (isSearchComponent(interaction)) return handleSearchComponent(interaction, runIntent);
    const id = interaction.customId.slice(PREFIX.length);
    const guild = interaction.guild;
    const privately = (content) => interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } }).catch(() => {});
    if (!guild) return undefined;

    const q = music.queue(guild.id);
    if (!q.current && !q.loading) {
        await interaction.update(finishedPayload('queue-end')).catch(() => {});
        return undefined;
    }
    if (id === 'queue') {
        const lines = upNextLines(q.tracks, 15);
        return privately([
            `🎵 **Now playing:** ${q.current ? music.describeTrack(q.current) : 'loading…'}${q.loop !== 'off' ? ` 🔁 (${q.loop})` : ''}`,
            lines.length ? `**Up next:**\n${lines.join('\n')}` : 'Nothing else queued.'
        ].join('\n'));
    }

    const build = BUTTON_ACTIONS[id];
    if (!build) return privately('❌ Unknown button.');
    await interaction.deferUpdate().catch(() => {});
    const result = String(await runIntent(build(q)) || '');
    // Successful presses update the panel through player events; problems get a private note.
    if (/^(❌|💎|🎧|🎵|🔒)/u.test(result)) {
        await interaction.followUp({ content: result, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } }).catch(() => {});
    }
    return undefined;
}

module.exports = { isMusicComponent, handleMusicComponent, buildPanel, finishedPayload, BUTTON_ACTIONS, PREFIX };
