/**
 * /search: shows up to 5 results (title, artist, length, source) in a pick
 * list. Only the member who searched may pick; picks expire after 2 minutes.
 * The chosen track is played through the normal 'play' action, so every
 * permission / premium / DJ check still applies.
 */
const crypto = require('node:crypto');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, StringSelectMenuBuilder, MessageFlags } = require('discord.js');
const sources = require('./sources');
const { formatDuration } = require('./player');

const PICK_PREFIX = 'zigmusic:pick:';
const CANCEL_PREFIX = 'zigmusic:pickcancel:';
const TTL_MS = 2 * 60_000;
const MAX_PENDING = 500;
const pending = new Map(); // token -> { results, userId, expiresAt }

function sweep(now = Date.now()) {
    for (const [token, entry] of pending) if (entry.expiresAt <= now) pending.delete(token);
    while (pending.size > MAX_PENDING) pending.delete(pending.keys().next().value);
}

/** Search the preferred source, falling back to the other one when it finds nothing. */
async function searchWithFallback(query) {
    const first = sources.preferredSource();
    const second = first === 'youtube' ? 'soundcloud' : 'youtube';
    let error = null;
    try {
        const results = await sources.search(query, { source: first, limit: 5 });
        if (results.length) return results;
    } catch (e) {
        error = e;
    }
    const results = await sources.search(query, { source: second, limit: 5 }).catch(() => []);
    if (results.length) return results;
    if (error && /not installed|took too long/.test(error.message)) throw error;
    return [];
}

function resultLine(track, index) {
    const length = formatDuration(track.duration);
    return `**${index + 1}.** ${track.title}${track.artist ? ` — ${track.artist}` : ''}${length ? ` · \`${length}\`` : ''}`;
}

/** Message payload with the pick list, or an "ℹ️ no results" line. */
async function searchPayload({ query, userId }) {
    const results = await searchWithFallback(query);
    if (!results.length) return `🔎 No playable results for "${query.slice(0, 80)}". Try other words.`;
    sweep();
    const token = crypto.randomBytes(9).toString('base64url');
    pending.set(token, { results, userId: String(userId), expiresAt: Date.now() + TTL_MS });

    const embed = new EmbedBuilder()
        .setColor(0xa855f7)
        .setTitle(`🔎 Results for "${query.slice(0, 80)}"`)
        .setDescription(results.map(resultLine).join('\n'))
        .setFooter({ text: `From ${sources.SOURCE_LABEL[results[0].source]} · pick within 2 minutes` });
    if (results[0].thumbnail) embed.setThumbnail(results[0].thumbnail);

    const menu = new StringSelectMenuBuilder()
        .setCustomId(PICK_PREFIX + token)
        .setPlaceholder('Choose a song to play')
        .addOptions(results.map((track, index) => ({
            label: `${index + 1}. ${track.title}`.slice(0, 100),
            description: [track.artist, formatDuration(track.duration)].filter(Boolean).join(' · ').slice(0, 100) || undefined,
            value: String(index)
        })));
    const cancel = new ButtonBuilder().setCustomId(CANCEL_PREFIX + token).setLabel('Cancel').setStyle(ButtonStyle.Secondary);
    return {
        embeds: [embed],
        components: [new ActionRowBuilder().addComponents(menu), new ActionRowBuilder().addComponents(cancel)],
        allowedMentions: { parse: [] }
    };
}

function isSearchComponent(interaction) {
    const id = String(interaction.customId || '');
    return id.startsWith(PICK_PREFIX) || id.startsWith(CANCEL_PREFIX);
}

/** Handle a pick / cancel. runIntent(intent) plays through the normal checks and returns the reply text. */
async function handleSearchComponent(interaction, runIntent) {
    const id = interaction.customId;
    const cancel = id.startsWith(CANCEL_PREFIX);
    const token = id.slice((cancel ? CANCEL_PREFIX : PICK_PREFIX).length);
    const entry = pending.get(token);
    const privately = (content) => interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } }).catch(() => {});

    if (!entry || entry.expiresAt <= Date.now()) {
        pending.delete(token);
        await interaction.update({ components: [] }).catch(() => {});
        return privately('⌛ That search expired. Run `/search` again.');
    }
    if (String(interaction.user.id) !== entry.userId) return privately('🔒 Only the person who searched can pick a result.');

    pending.delete(token);
    if (cancel) {
        return interaction.update({ content: '✖️ Search cancelled.', embeds: [], components: [] }).catch(() => {});
    }
    const track = entry.results[Number(interaction.values?.[0])];
    if (!track) return privately('❌ Unknown choice.');

    await interaction.deferUpdate().catch(() => {});
    const result = String(await runIntent({ action: 'play', target: track.url, track: { ...track } }) || '');
    await interaction.editReply({ content: result, embeds: [], components: [], allowedMentions: { parse: [] } }).catch(() => {});
}

module.exports = { searchPayload, isSearchComponent, handleSearchComponent, searchWithFallback };
