/**
 * /memory: member-facing control over ZiGBoT's stored memories.
 *
 * Every reply is ephemeral and mentions nobody. The member and server always
 * come from the interaction itself (never from typed input), so each
 * subcommand can only ever touch the caller's own memories in this server.
 * Success is reported only after MongoDB confirms the operation; every
 * failure says plainly that nothing was confirmed.
 */
const crypto = require('node:crypto');
const {
    ActionRowBuilder,
    AttachmentBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags,
    escapeMarkdown
} = require('discord.js');
const { RateLimiter } = require('../ai/rateLimiter');

const CLEAR_CONFIRM_MS = 60_000;
const CLEAR_PREFIX = 'zigmem_clear_';
const REPLY_MAX = 1900;
const LINE_CONTENT_MAX = 180;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const WRITE_SUBCOMMANDS = new Set(['remember', 'correct', 'forget', 'clear', 'on', 'off']);
const NO_MENTIONS = { parse: [] };

const UNAVAILABLE = '⚠️ Persistent memory is temporarily unavailable (database unreachable). Nothing was read or changed.';
const RATE_LIMITED = '⏳ Too many memory commands from you in this server recently. Try again in a few minutes.';

// Untrusted stored text -> safe Discord text: one line, bounded, markdown
// escaped, and mass/user mentions neutralised (allowedMentions also blocks pings).
function safeText(text, max = LINE_CONTENT_MAX) {
    let value = String(text ?? '').replace(/\s+/g, ' ').trim();
    if (value.length > max) value = `${value.slice(0, max - 1)}…`;
    return escapeMarkdown(value)
        .replace(/@(everyone|here)/gi, '@​$1')
        .replace(/<(@[!&]?|#)(\d+)>/g, '<​$1$2>');
}

function sourceLabel(memory) {
    if (memory.source === 'explicit') return 'saved by you';
    if (memory.verified) return 'confirmed by you';
    if (memory.source === 'legacy') return 'older record, unverified';
    return 'auto-saved, unverified';
}

function formatMemoryLine(memory) {
    const when = Number.isFinite(memory.created_at) ? ` · <t:${Math.floor(memory.created_at / 1000)}:d>` : '';
    return `\`#${memory.id}\` [${memory.type}] ${safeText(memory.content)} — _${sourceLabel(memory)}_${when}`;
}

// Joins lines under Discord's limit; says how many did not fit.
function fitLines(header, lines, footer = '') {
    const kept = [];
    let length = header.length + footer.length + 40;
    for (const line of lines) {
        if (length + line.length + 1 > REPLY_MAX) break;
        kept.push(line);
        length += line.length + 1;
    }
    const hidden = lines.length - kept.length;
    const more = hidden > 0 ? `\n…${hidden} more not shown.` : '';
    return `${header}\n${kept.join('\n')}${more}${footer ? `\n${footer}` : ''}`;
}

function relativeTime(ms) {
    return Number.isFinite(ms) ? `<t:${Math.floor(ms / 1000)}:R>` : 'not since the bot started';
}

function isKnownError(error, name) {
    return error && error.name === name;
}

// Pending /memory clear confirmations, kept in this process only: after a
// restart an old button simply reports "expired" and deletes nothing.
class ClearRequests {
    constructor({ ttlMs = CLEAR_CONFIRM_MS } = {}) {
        this.ttlMs = ttlMs;
        this.pending = new Map();
    }

    create(guildId, userId, now = Date.now()) {
        const id = crypto.randomBytes(8).toString('hex');
        this.pending.set(id, { guildId: String(guildId), userId: String(userId), expiresAt: now + this.ttlMs });
        return id;
    }

    // ok | forbidden | expired | unknown. Only the requester in the same
    // server may resolve; ok and expired consume the request (one use).
    resolve(id, clickerId, guildId, now = Date.now()) {
        const request = this.pending.get(id);
        if (!request) return { status: 'unknown' };
        if (String(clickerId) !== request.userId || String(guildId) !== request.guildId) return { status: 'forbidden' };
        this.pending.delete(id);
        if (now > request.expiresAt) return { status: 'expired' };
        return { status: 'ok', request };
    }

    // Timer path: true when the request was still pending (and is now gone).
    expire(id) {
        return this.pending.delete(id);
    }
}

function clearButtons(id) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`${CLEAR_PREFIX}confirm_${id}`).setLabel('Delete all my memories here').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`${CLEAR_PREFIX}cancel_${id}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary)
    );
}

function isMemoryComponent(interaction) {
    return Boolean(interaction?.isButton?.() && String(interaction.customId || '').startsWith(CLEAR_PREFIX));
}

function createMemoryCommands({
    brain,
    autoCapture = false,
    readLimiter = new RateLimiter({ max: 30, windowMs: RATE_WINDOW_MS }),
    writeLimiter = new RateLimiter({ max: 10, windowMs: RATE_WINDOW_MS }),
    clearRequests = new ClearRequests(),
    now = () => Date.now(),
    schedule = (fn, ms) => setTimeout(fn, ms).unref?.()
} = {}) {
    const logFailure = (subcommand, error) => {
        // Name/code only: database messages are safe, but never log content.
        console.error(`[ZiGBoT MEMORY CMD] ${subcommand} failed: ${error?.code || error?.name || 'Error'}`);
    };

    // ctx: { guildId, userId, displayName, options, botEnabled, memoryAllowedByServer, runDiagnostics }
    // Returns { content, files?, components?, clearRequestId? }.
    async function runSubcommand(subcommand, ctx) {
        const { guildId, userId, options } = ctx;
        const limiter = WRITE_SUBCOMMANDS.has(subcommand) ? writeLimiter : readLimiter;
        if (!limiter.attempt(`${guildId}:${userId}`, now())) return { content: RATE_LIMITED };

        if (subcommand === 'diagnostics') {
            // Owner/admin gate runs server-side inside the router (memory_status).
            const member = options.getUser('member');
            return { content: await ctx.runDiagnostics(member ? `<@${member.id}>` : null) };
        }
        if (subcommand === 'status') return { content: await statusText(ctx) };
        if (!brain.isMemoryAvailable()) return { content: UNAVAILABLE };

        switch (subcommand) {
            case 'view': return { content: await viewText(ctx) };
            case 'search': return { content: await searchText(ctx) };
            case 'remember': return { content: await rememberText(ctx) };
            case 'correct': return { content: await correctText(ctx) };
            case 'forget': return { content: await forgetText(ctx) };
            case 'clear': return clearPrompt(ctx);
            case 'on': return { content: await setPreferenceText(ctx, true) };
            case 'off': return { content: await setPreferenceText(ctx, false) };
            case 'export': return exportPayload(ctx);
            default: return { content: '❌ Unknown memory command.' };
        }
    }

    async function statusText({ guildId, userId, memoryAllowedByServer }) {
        const lines = ['🧠 **Your memory in this server** (only you can see this)'];
        const available = brain.isMemoryAvailable();
        let preferenceLine = '⚠️ could not be checked, so it is treated as **OFF** until it can be verified';
        let countLine = '⚠️ could not be checked';
        if (available) {
            try {
                const preference = await brain.getMemoryPreference(guildId, userId);
                preferenceLine = preference.enabled ? '✅ **ON**' : '⏸️ **OFF** (you turned it off)';
            } catch (error) {
                logFailure('status preference', error);
            }
            try {
                countLine = String(await brain.countMemories(guildId, userId));
            } catch (error) {
                logFailure('status count', error);
            }
        }
        const status = brain.getMemoryStatus();
        lines.push(`• Your personal memory: ${preferenceLine}`);
        lines.push(`• Server setting: ${memoryAllowedByServer ? 'memory allowed' : 'memory is turned off by this server\'s admins or for your roles'}`);
        lines.push(`• Database: ${available ? '✅ connected' : '❌ unavailable'} · last successful write ${relativeTime(status.lastWriteOkAt)} · last successful read ${relativeTime(status.lastReadOkAt)}`);
        lines.push(`• Automatic saving: ${autoCapture ? 'ON' : 'OFF — I only save what you add with `/memory remember`'}`);
        lines.push(`• Your stored memories here: ${countLine}`);
        lines.push('• Sharing: off — your memories are only ever used in replies to you, never shown to other members or the server owner.');
        lines.push('• What can be stored: facts, preferences, events, and context, up to 500 characters each, kept for 30 days. Never passwords, keys, tokens, or instructions aimed at the bot.');
        return lines.join('\n');
    }

    async function viewText({ guildId, userId, options }) {
        try {
            const page = options.getInteger('page') || 1;
            const result = await brain.listMemories(guildId, userId, { page });
            if (result.total === 0) return 'You have no stored memories in this server.';
            let footer = 'Use `/memory correct` or `/memory forget` with the #id.';
            try {
                const preference = await brain.getMemoryPreference(guildId, userId);
                if (!preference.enabled) footer = `Memory is OFF for you: these are kept until they expire but are not used in replies. ${footer}`;
            } catch {
                footer = `Your memory setting could not be checked, so these are not used in replies right now. ${footer}`;
            }
            return fitLines(
                `🧠 **Your memories here** — page ${result.page}/${result.pages}, ${result.total} total, newest first:`,
                result.items.map(formatMemoryLine),
                footer
            );
        } catch (error) {
            logFailure('view', error);
            return '❌ Could not load your memories (database error). Nothing was changed.';
        }
    }

    async function searchText({ guildId, userId, options }) {
        try {
            const result = await brain.searchMemories(guildId, userId, options.getString('query', true));
            if (result.items.length === 0) return 'No saved memory of yours in this server matches that search.';
            return fitLines(
                `🔎 **Matching memories** (${result.items.length}${result.more ? '+' : ''}, newest first):`,
                result.items.map(formatMemoryLine),
                result.more ? 'More matches exist — try a more specific search.' : ''
            );
        } catch (error) {
            if (isKnownError(error, 'MemoryValidationError')) return `❌ ${error.message}`;
            logFailure('search', error);
            return '❌ Search failed (database error). Nothing was changed.';
        }
    }

    async function rememberText({ guildId, userId, displayName, options, botEnabled, memoryAllowedByServer }) {
        if (!botEnabled) return '❌ ZiGBoT is switched off in this server by its admins, so nothing was saved.';
        if (!memoryAllowedByServer) return '❌ Memory is turned off in this server (or for your roles), so nothing was saved.';
        const text = options.getString('text', true);
        const type = options.getString('type') || 'fact';
        try {
            const saved = await brain.remember(guildId, userId, text, type, { source: 'explicit', authorName: displayName });
            if (saved.duplicate) return `ℹ️ That is already saved as \`#${saved.id}\` — nothing new was stored.`;
            return `✅ Saved as \`#${saved.id}\` (${saved.type}). MongoDB confirmed the write. It is kept for 30 days.`;
        } catch (error) {
            if (isKnownError(error, 'MemoryDisabledError')) return '⏸️ Your memory is OFF in this server, so nothing was saved. Use `/memory on` first.';
            if (isKnownError(error, 'MemoryValidationError')) return `❌ Not saved: ${error.message}`;
            logFailure('remember', error);
            return '❌ Not saved: the database did not confirm the write (or your memory setting could not be verified). Check `/memory view` before trying again.';
        }
    }

    async function correctText({ guildId, userId, options }) {
        const id = options.getInteger('id', true);
        try {
            const updated = await brain.updateMemory(guildId, userId, id, {
                content: options.getString('text', true),
                type: options.getString('type') || undefined,
                verified: true
            });
            if (!updated) return `❌ You have no memory \`#${id}\` in this server (it may have expired or been deleted). Nothing was changed.`;
            return `✏️ Updated \`#${updated.id}\`: ${safeText(updated.content)}`;
        } catch (error) {
            if (isKnownError(error, 'MemoryValidationError')) return `❌ Not changed: ${error.message}`;
            logFailure('correct', error);
            return '❌ Not changed: the database did not confirm the update. Check `/memory view`.';
        }
    }

    async function forgetText({ guildId, userId, options }) {
        const id = options.getInteger('id', true);
        try {
            const deleted = await brain.deleteMemoryById(guildId, userId, id);
            return deleted
                ? `🗑️ Deleted memory \`#${id}\`.`
                : `ℹ️ You have no memory \`#${id}\` in this server — nothing was deleted.`;
        } catch (error) {
            if (isKnownError(error, 'MemoryValidationError')) return `❌ ${error.message}`;
            logFailure('forget', error);
            return '❌ The database did not confirm the delete, so it may still be stored. Check `/memory view`.';
        }
    }

    async function clearPrompt({ guildId, userId }) {
        let count;
        try {
            count = await brain.countMemories(guildId, userId);
        } catch (error) {
            logFailure('clear count', error);
            return { content: '❌ Could not check your memories (database error). Nothing was deleted.' };
        }
        if (count === 0) return { content: 'You have no stored memories in this server — nothing to clear.' };
        const id = clearRequests.create(guildId, userId, now());
        return {
            content: `⚠️ This permanently deletes **all ${count}** of your stored memories in **this server**. Memories in other servers, warnings, and other records are not affected.\nConfirm within 60 seconds; otherwise nothing is deleted.`,
            components: [clearButtons(id)],
            clearRequestId: id
        };
    }

    async function setPreferenceText({ guildId, userId }, enabled) {
        try {
            await brain.setMemoryPreference(guildId, userId, enabled);
        } catch (error) {
            logFailure(enabled ? 'on' : 'off', error);
            return '❌ The database did not confirm the change, so your memory setting may not have changed. While it cannot be verified, your memories are not used.';
        }
        if (enabled) {
            return `✅ Memory is **ON** for you in this server. ${autoCapture ? '' : 'Automatic saving is off, so I only save what you add with `/memory remember`.'}`.trim();
        }
        let kept = '';
        try {
            const count = await brain.countMemories(guildId, userId);
            if (count > 0) kept = ` Your ${count} stored memor${count === 1 ? 'y is' : 'ies are'} kept until they expire (30 days) — \`/memory clear\` deletes them now.`;
        } catch {
            kept = ' Use `/memory view` to see what is still stored.';
        }
        return `⏸️ Memory is **OFF** for you in this server. I will not save new memories or use stored ones in replies (text or voice), and the owner's memory lookup shows nothing about you.${kept}`;
    }

    async function exportPayload({ guildId, userId }) {
        let result;
        try {
            result = await brain.exportMemories(guildId, userId);
        } catch (error) {
            logFailure('export', error);
            return { content: '❌ Export failed (database error). Nothing was exported.' };
        }
        if (result.total === 0) return { content: 'You have no stored memories in this server — nothing to export.' };
        const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
        const body = {
            exported_at: new Date(now()).toISOString(),
            guild_id: String(guildId),
            user_id: String(userId),
            total_stored: result.total,
            exported: result.items.length,
            truncated: result.truncated,
            note: 'Only your own memories in this server. Warnings, behavior records, and other members\' data are not included.',
            memories: result.items.map((memory) => ({
                id: memory.id,
                type: memory.type,
                content: memory.content,
                source: memory.source,
                verified: memory.verified,
                scope: memory.scope,
                created_at: iso(memory.created_at),
                updated_at: iso(memory.updated_at),
                expires_at: iso(memory.expires_at)
            }))
        };
        const file = new AttachmentBuilder(Buffer.from(JSON.stringify(body, null, 2), 'utf8'), {
            name: `zigbot-memories-${guildId}.json`
        });
        const limitNote = result.truncated ? ` (the newest ${result.items.length} of ${result.total}; exports are capped at ${result.limit})` : '';
        return { content: `📦 Your ${result.items.length} memor${result.items.length === 1 ? 'y' : 'ies'} from this server${limitNote}. Only you can see this file.`, files: [file] };
    }

    // Entry point for the /memory slash command. resolveContext() runs AFTER
    // the deferral (it may hit Supabase) and returns
    // { botEnabled, memoryAllowedByServer, runDiagnostics }.
    async function handleSlash(interaction, { resolveContext }) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const send = (payload) => interaction.editReply({ allowedMentions: NO_MENTIONS, ...payload });
        if (!interaction.guild) {
            await send({ content: 'Memory is kept per server — use `/memory` inside a server.' });
            return;
        }
        const subcommand = interaction.options.getSubcommand();
        try {
            const context = await resolveContext();
            const { clearRequestId, ...payload } = await runSubcommand(subcommand, {
                ...context,
                guildId: interaction.guild.id,
                userId: interaction.user.id,
                displayName: interaction.member?.displayName || interaction.user.username,
                options: interaction.options
            });
            await send({ components: [], ...payload });
            if (clearRequestId) {
                schedule(() => {
                    if (clearRequests.expire(clearRequestId)) {
                        send({ content: '⌛ Confirmation expired. Nothing was deleted.', components: [] }).catch(() => {});
                    }
                }, CLEAR_CONFIRM_MS);
            }
        } catch (error) {
            logFailure(subcommand, error);
            await send({ content: '❌ That memory command failed unexpectedly. Check `/memory view` to see what is stored.', components: [] }).catch(() => {});
        }
    }

    // Confirm/Cancel buttons from /memory clear.
    async function handleComponent(interaction) {
        const match = String(interaction.customId).match(/^zigmem_clear_(confirm|cancel)_([0-9a-f]{16})$/);
        const update = (content) => interaction.update({ content, components: [], allowedMentions: NO_MENTIONS });
        if (!match) return update('⌛ This request is no longer valid. Nothing was deleted.');
        const [, choice, id] = match;
        const result = clearRequests.resolve(id, interaction.user?.id, interaction.guildId, now());
        if (result.status === 'forbidden') {
            return interaction.reply({ content: '❌ Only the member who asked can confirm this.', flags: MessageFlags.Ephemeral, allowedMentions: NO_MENTIONS });
        }
        if (result.status !== 'ok') return update('⌛ This request expired. Nothing was deleted.');
        if (choice === 'cancel') return update('Cancelled. Nothing was deleted.');
        try {
            const deleted = await brain.deleteAllMemories(result.request.guildId, result.request.userId);
            return update(`🗑️ Deleted ${deleted} stored memor${deleted === 1 ? 'y' : 'ies'} of yours in this server.`);
        } catch (error) {
            logFailure('clear', error);
            return update('❌ The database did not confirm the delete, so some or all of your memories may still be stored. Check `/memory view`.');
        }
    }

    return { runSubcommand, handleSlash, handleComponent, isMemoryComponent, clearRequests };
}

module.exports = {
    createMemoryCommands,
    isMemoryComponent,
    ClearRequests,
    safeText,
    CLEAR_CONFIRM_MS,
    CLEAR_PREFIX
};
