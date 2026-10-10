const { ChatterCache, normalizeDisplayName } = require('./chatterCache');
const YT_API = require('./apiClient');
const { auditLog: defaultAuditLog } = require('../logging/auditLog');
const { YouTubeRoast } = require('./roast');

// Official YouTube Data API quota costs (Quota Calculator, checked 2026-10-10).
const LIVE_CHAT_BAN_COST = 200; // liveChatBans.insert/delete
const LIVE_CHAT_MESSAGE_DELETE_COST = 20; // liveChatMessages.delete
const CHAT_REPLY_COST = 20; // liveChatMessages.insert
const DEFAULT_MOD_QUOTA_RESERVE = 400;
const DEFAULT_MAX_MOD_ACTIONS_PER_STREAM = 25;
const DEFAULT_MOD_ACTION_COOLDOWN_MS = 2_000;
const BAN_CONFIRMATION_MS = 30_000;
const MAX_DELETE_COUNT = 10;
const TEMP_BAN_MINUTES = 1;
const TEMP_BAN_MAX_MINUTES = 1_440;

function parseTargetAndTail(input, cache) {
    const raw = String(input || '').trim();
    if (!raw) return { error: 'missing' };
    const quoted = /^(["'])(.*?)\1(?:\s+(.*))?$/.exec(raw);
    if (quoted) {
        const candidates = cache.findByName(quoted[2]);
        return { candidates, tail: quoted[3] || '', requested: quoted[2] };
    }
    const idMatch = /^(UC[A-Za-z0-9_-]+)(?:\s+(.*))?$/.exec(raw);
    if (idMatch) {
        const cached = cache.byChannelId(idMatch[1]);
        return { candidates: cached ? [cached] : [], tail: idMatch[2] || '', requested: idMatch[1] };
    }

    const words = raw.split(/\s+/);
    let best = null;
    for (let length = 1; length <= words.length; length += 1) {
        const name = words.slice(0, length).join(' ');
        const candidates = cache.findByName(name);
        if (candidates.length) best = { candidates, tail: words.slice(length).join(' '), requested: name };
    }
    return best || { candidates: [], tail: '', requested: words[0] };
}

function auditValue(value, limit = 240) {
    let text = String(value ?? 'none').replace(/[\p{Cc}\p{Cf}\r\n]/gu, ' ').replace(/\s+/g, ' ').trim();
    for (const secret of [process.env.YOUTUBE_REFRESH_TOKEN, process.env.YOUTUBE_CLIENT_SECRET]) {
        if (secret) text = text.split(secret).join('[redacted]');
    }
    return text.slice(0, limit) || 'none';
}

class YouTubeCommandRouter {
    constructor({ youtube, videoId, liveChatId, ownerId, selfId, botTitle = null, config = {}, greetings,
        brain = null, discordClient = null, settings = null, auditLog = defaultAuditLog,
        clock = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout,
        api = YT_API, onNotice = () => {}, chatterCache = null, ai = null, roastRateLimiter = null,
        roastService = null, random = Math.random } = {}) {
        this.youtube = youtube; this.videoId = videoId; this.liveChatId = liveChatId;
        this.ownerId = ownerId; this.selfId = selfId; this.botTitle = botTitle || config.botName || 'ZiGBoT'; this.config = config; this.greetings = greetings;
        this.brain = brain; this.discordClient = discordClient; this.settings = settings || { logChannelId: process.env.LOG_CHANNEL_ID || '' };
        this.auditLog = auditLog; this.clock = clock; this.setTimer = setTimer; this.clearTimer = clearTimer;
        this.api = api; this.onNotice = onNotice; this.cache = chatterCache || new ChatterCache({ clock });
        this.enabled = Boolean(config.moderationEnabled);
        this.actionsUsed = 0; this.lastBanActionAt = null; this.quotaStopped = false;
        this.forbiddenBlocked = false; this.authBlocked = false; this.forbiddenNotice = false; this.authNotice = false; this.quotaNotice = false;
        this.pendingBan = null; this.banIds = new Map(); this.persistenceNotice = false;
        this.reserve = Number.isFinite(config.moderationQuotaReserve) ? config.moderationQuotaReserve : DEFAULT_MOD_QUOTA_RESERVE;
        this.maxActions = Number.isFinite(config.maxModerationActionsPerStream) ? config.maxModerationActionsPerStream : DEFAULT_MAX_MOD_ACTIONS_PER_STREAM;
        this.actionCooldown = Number.isFinite(config.moderationActionCooldownMs) ? config.moderationActionCooldownMs : DEFAULT_MOD_ACTION_COOLDOWN_MS;
        this.roast = roastService || new YouTubeRoast({ ai, rateLimiter: roastRateLimiter, config: { ...config, ownerId, selfId },
            greetings, cache: this.cache, brain, videoId, api, clock, setTimer, clearTimer, random,
            audit: (entry) => this.auditRoast(entry) });
    }

    get active() { return this.enabled && !this.quotaStopped && !this.authBlocked && !this.forbiddenBlocked; }

    async handleMessage(message) {
        if (message?.eventType && message.eventType !== 'textMessageEvent') return false;
        this.cache.record(message);
        const prefix = this.config.commandPrefix || '!';
        const text = String(message?.rawText ?? message?.text ?? '').trimStart();
        if (!text.startsWith(prefix)) return false;
        const author = message.author || {};
        // Never feed a bot's own output back into the command parser.
        if ((author.channelId && author.channelId === this.selfId)
            || (!this.selfId && normalizeDisplayName(author.displayName) === normalizeDisplayName(this.botTitle))) return true;
        const payload = text.slice(prefix.length).trimStart();
        const match = /^([\p{L}]+)?(?:\s+([\s\S]*))?$/iu.exec(payload);
        const command = String(match?.[1] || 'unknown').toLocaleLowerCase();
        const args = match?.[2] || '';
        const ownerAuthorized = author.channelId === this.ownerId && author.isChatOwner === true;
        if (!ownerAuthorized) {
            const denialTarget = args ? parseTargetAndTail(args, this.cache) : null;
            const target = denialTarget?.candidates?.length === 1 ? denialTarget.candidates[0]
                : denialTarget?.requested ? { displayName: denialTarget.requested, channelId: null } : this.pendingBan?.target || null;
            await this.audit(message, command, target, '', 'DENIED', { failureReason: 'not the verified stream owner', userChannelId: author.channelId || 'unknown' });
            return true;
        }
        if (!['timeout', 'ban', 'unban', 'delete', 'confirm', 'cancel', 'roast', 'roastmode', 'noroast', 'yesroast'].includes(command)) {
            await this.audit(message, command, null, '', 'FAILED', { failureReason: 'unknown command' });
            return true;
        }
        try {
            if (['roast', 'roastmode', 'noroast', 'yesroast'].includes(command)) await this.executeRoast(message, command, args.trim());
            else if (command === 'confirm' || command === 'cancel') await this.confirmationCommand(message, command);
            else await this.execute(message, command, args.trim());
        } catch (error) {
            await this.audit(message, command, null, '', 'FAILED', { failureReason: error?.message || 'unexpected failure' });
            this.reply('moderation command failed; no further action was taken.');
        }
        return true;
    }

    async audit(message, action, target, reason, result, extra = {}) {
        const syntheticMessage = { author: { id: message?.author?.channelId || 'unknown' }, client: this.discordClient };
        const detailValues = { channelId: target?.channelId || extra.channelId || 'none',
            reason: reason || extra.reason || extra.failureReason || 'none', videoId: this.videoId, ...extra };
        const details = Object.fromEntries(Object.entries(detailValues).map(([key, value]) => [key, auditValue(value)]));
        try {
            await this.auditLog({ message: syntheticMessage, settings: this.settings, event: 'YOUTUBE MODERATION', action,
                target: auditValue(target?.displayName || (typeof target === 'string' ? target : 'none'), 100), result, details });
        } catch (error) {
            this.onNotice('YouTube moderation audit could not be delivered to Discord.');
        }
    }

    async auditRoast({ message, target, trigger, result, filtered, preview, reason }) {
        const syntheticMessage = { author: { id: message?.author?.channelId || 'unknown' }, client: this.discordClient };
        const details = Object.fromEntries(Object.entries({ channelId: target?.channelId || 'none', videoId: this.videoId,
            trigger, filtered, preview, reason }).map(([key, value]) => [key, auditValue(value, key === 'preview' ? 60 : 160)]));
        try {
            await this.auditLog({ message: syntheticMessage, settings: this.settings, event: 'YOUTUBE ROAST',
                action: 'roast', target: auditValue(target?.displayName || 'unknown', 100), result, details });
        } catch { this.onNotice('YouTube roast audit could not be delivered to Discord.'); }
    }

    async executeRoast(message, command, args) {
        if (this.config.roastEnabled === false || !this.roast.enabled) {
            await this.auditRoast({ message, target: null, trigger: command, result: 'DISABLED', filtered: false, preview: '', reason: 'roast feature disabled' });
            this.reply('YouTube roasts are disabled.'); return;
        }
        if (command === 'roastmode') {
            const value = args.toLowerCase();
            const prefix = this.config.commandPrefix || '!';
            if (!['on', 'off'].includes(value)) { this.reply(`use ${prefix}roastmode on or ${prefix}roastmode off.`); return; }
            this.roast.mode = value === 'on';
            await this.auditRoast({ message, target: null, trigger: command, result: this.roast.mode ? 'ON' : 'OFF', filtered: false, preview: '', reason: 'owner setting' });
            this.reply(`roast mode ${this.roast.mode ? 'on' : 'off'} for this stream.`); return;
        }
        const parsed = parseTargetAndTail(args, this.cache);
        if (parsed.error || parsed.candidates?.length !== 1) {
            await this.auditRoast({ message, target: { displayName: parsed.requested || 'unknown' }, trigger: command, result: 'FAILED', filtered: false, preview: '', reason: parsed.candidates?.length > 1 ? 'ambiguous target' : 'target not found' });
            this.reply(`couldn't find a single match for ${String(parsed.requested || 'that name').slice(0, 70)}.`); return;
        }
        const target = parsed.candidates[0];
        if (command === 'noroast' || command === 'yesroast') {
            if (target.channelId === this.ownerId || target.channelId === this.selfId || target.protected || target.isBot) {
                this.reply('that account is protected.'); return;
            }
            await this.roast.setNoRoast(target.channelId, command === 'noroast');
            await this.auditRoast({ message, target, trigger: command, result: command === 'noroast' ? 'ADDED' : 'REMOVED', filtered: false, preview: '', reason: 'owner setting' });
            this.reply(`${target.displayName} ${command === 'noroast' ? 'added to' : 'removed from'} the no-roast list.`); return;
        }
        const result = await this.roast.roast(target, 'command', message);
        if (result.ok) return;
        const lines = { 'off-limits': 'that viewer is on the no-roast list.', crisis: 'that viewer was skipped because their recent message may indicate distress.', protected: 'that viewer is protected.', member: 'paying members are off-limits.', quota: 'not enough YouTube quota remains for a roast.', 'ai-failure': 'I could not generate that roast right now.', cap: 'the stream roast limit has been reached.', interval: 'wait a few seconds before another roast.', cooldown: 'that viewer is still on cooldown.', 'rate-limit': 'YouTube roast AI is rate-limited right now.', disabled: 'YouTube roasts are disabled.', queue: 'the YouTube chat reply queue is full.' };
        if (result.blocked !== 'filtered') this.reply(lines[result.blocked] || 'that roast was skipped.');
    }

    reply(text, emergency = false) {
        return this.greetings?.enqueueText(text, { quotaReserve: emergency ? 0 : this.reserve }) || false;
    }

    async resolveTarget(raw, message, action, reason = '') {
        const parsed = parseTargetAndTail(raw, this.cache);
        if (parsed.error || !parsed.candidates?.length || parsed.candidates.length !== 1) {
            const requested = String(parsed.requested || raw || 'that name').replace(/[\p{Cc}\p{Cf}]/gu, '').slice(0, 70);
            const reply = `couldn't find a single match for ${requested || 'that name'}, use their exact name or channel id`;
            await this.audit(message, action, { displayName: requested, channelId: null }, reason, 'FAILED', { failureReason: parsed.candidates?.length > 1 ? 'ambiguous target' : 'target not found' });
            this.reply(reply);
            return null;
        }
        const target = parsed.candidates[0];
        if (target.channelId === this.ownerId || target.channelId === this.selfId || target.protected || target.isBot
            || (!this.selfId && target.normalizedName === normalizeDisplayName(this.botTitle))) {
            await this.audit(message, action, target, reason, 'FAILED', { failureReason: 'protected target' });
            this.reply(`refusing to act on ${target.displayName}; owner, moderator and bot accounts are protected`);
            return null;
        }
        return { target, tail: parsed.tail };
    }

    async execute(message, command, args) {
        if (!this.config.moderationEnabled || !this.enabled) {
            await this.audit(message, command, null, '', 'FAILED', { failureReason: 'YouTube moderation is disabled' });
            this.reply('YouTube moderation is off.');
            return;
        }
        if (!this.active) {
            await this.audit(message, command, null, '', 'FAILED', { failureReason: this.forbiddenBlocked ? 'missing live-chat moderator permission' : this.authBlocked ? 'YouTube authentication failed' : 'YouTube quota reserve reached' });
            if (this.forbiddenBlocked) {
                if (!this.forbiddenNotice) { this.forbiddenNotice = true; this.reply('I need to be added as a moderator to do that.', true); }
            } else if (this.authBlocked) {
                if (!this.authNotice) { this.authNotice = true; this.reply('YouTube authorization failed; moderation is paused.', true); }
            } else if (this.quotaStopped) {
                if (!this.quotaNotice) { this.quotaNotice = true; this.reply('moderation is paused until quota resets.', true); }
            } else this.reply('moderation is paused until YouTube access or quota is available.', true);
            return;
        }
        if (command === 'timeout') return this.timeout(message, args);
        if (command === 'ban') return this.ban(message, args);
        if (command === 'unban') return this.unban(message, args);
        if (command === 'delete') return this.deleteMessages(message, args);
    }

    async timeout(message, args) {
        const resolved = await this.resolveTarget(args, message, 'timeout');
        if (!resolved) return;
        let minutes = 5;
        let reason = '';
        const words = resolved.tail.trim().split(/\s+/).filter(Boolean);
        if (words.length && /^[+-]?\d+(?:\.\d+)?$/.test(words[0])) {
            minutes = Number(words.shift());
            if (!Number.isInteger(minutes) || minutes < TEMP_BAN_MINUTES || minutes > TEMP_BAN_MAX_MINUTES) {
                await this.audit(message, 'timeout', resolved.target, words.join(' '), 'FAILED', { failureReason: 'minutes must be 1–1440' });
                this.reply('timeout must be between 1 and 1440 minutes.');
                return;
            }
        }
        reason = words.join(' ').slice(0, 200);
        return this.performBan(message, 'timeout', resolved.target, reason, 'temporary', minutes * 60);
    }

    async ban(message, args) {
        const resolved = await this.resolveTarget(args, message, 'ban');
        if (!resolved) return;
        const reason = resolved.tail.trim().slice(0, 200);
        if (this.pendingBan) {
            await this.audit(message, 'ban', resolved.target, reason, 'FAILED', { failureReason: 'another ban awaits confirmation' });
            const prefix = this.config.commandPrefix || '!';
            this.reply(`a ban is already waiting for ${prefix}confirm or ${prefix}cancel.`);
            return;
        }
        this.pendingBan = { target: resolved.target, reason, requesterChannelId: message.author.channelId, message,
            action: 'ban', expiresAt: this.clock() + BAN_CONFIRMATION_MS, timer: null };
        this.pendingBan.timer = this.setTimer(() => { this.expirePendingBan(); }, BAN_CONFIRMATION_MS);
        await this.audit(message, 'ban', resolved.target, reason, 'PENDING', { expiresInMs: BAN_CONFIRMATION_MS });
        const prefix = this.config.commandPrefix || '!';
        this.reply(`confirm permanent ban of ${resolved.target.displayName}: type ${prefix}confirm or ${prefix}cancel within 30 seconds`);
    }

    async confirmationCommand(message, command) {
        const pending = this.pendingBan;
        if (!pending || pending.requesterChannelId !== message.author.channelId || this.clock() >= pending.expiresAt) {
            if (pending && this.clock() >= pending.expiresAt) await this.expirePendingBan();
            await this.audit(message, command, pending?.target || null, pending?.reason || '', 'FAILED', { failureReason: 'no matching pending confirmation' });
            this.reply('there is no pending ban confirmation.');
            return;
        }
        if (command === 'confirm' && !this.active) {
            await this.audit(message, 'ban', pending.target, pending.reason, 'FAILED', { failureReason: 'moderation is disabled or paused' });
            this.reply('moderation is paused; the pending ban was not applied.', true);
            return;
        }
        this.clearTimer(pending.timer);
        this.pendingBan = null;
        if (command === 'cancel') {
            await this.audit(message, 'ban', pending.target, pending.reason, 'CANCELLED', { confirmation: 'cancelled' });
            this.reply('ban cancelled.');
            return;
        }
        await this.audit(message, 'ban', pending.target, pending.reason, 'CONFIRMED', { confirmation: 'confirmed' });
        await this.performBan(message, 'ban', pending.target, pending.reason, 'permanent', null);
    }

    async expirePendingBan() {
        const pending = this.pendingBan;
        if (!pending) return;
        this.pendingBan = null;
        this.clearTimer(pending.timer);
        await this.audit(pending.message, 'ban', pending.target, pending.reason, 'EXPIRED', { confirmation: 'expired' });
        this.reply('ban confirmation expired; no action was taken.');
    }

    async performBan(message, action, target, reason, type, durationSeconds) {
        const gate = await this.actionGate(message, action, target, reason, LIVE_CHAT_BAN_COST, true);
        if (!gate) return;
        this.actionsUsed += 1;
        this.lastBanActionAt = this.clock();
        try {
            const response = await this.api.ytCall(this.youtube, (params) => this.youtube.liveChatBans.insert(params), {
                part: 'snippet', requestBody: { snippet: { liveChatId: this.liveChatId, type,
                    ...(durationSeconds ? { banDurationSeconds: durationSeconds } : {}),
                    bannedUserDetails: { channelId: target.channelId } } }
            }, { costUnits: LIVE_CHAT_BAN_COST, budget: this.config.quotaBudgetPerDay, method: 'liveChatBans.insert' });
            const banId = response?.data?.id;
            if (banId) await this.storeBan(target, banId);
            await this.audit(message, action, target, reason, 'SUCCESS', { banId: banId || 'not returned', durationSeconds: durationSeconds || 'permanent' });
            this.reply(`${action === 'timeout' ? `timed out ${target.displayName} for ${Math.floor(durationSeconds / 60)} min` : `banned ${target.displayName}`}.`);
        } catch (error) { await this.actionFailure(message, action, target, reason, error); }
    }

    async unban(message, args) {
        const resolved = await this.resolveTarget(args, message, 'unban');
        if (!resolved) return;
        const reason = resolved.tail.trim().slice(0, 200);
        let banId = this.banIds.get(this.banKey(resolved.target.channelId));
        if (!banId && this.brain?.getYtBanId) {
            try { banId = await this.brain.getYtBanId(this.videoId, resolved.target.channelId); }
            catch (error) { this.persistenceFailed(error); }
        }
        if (!banId) {
            await this.audit(message, 'unban', resolved.target, reason, 'FAILED', { failureReason: 'bot-created ban id not found' });
            this.reply(`ban for ${resolved.target.displayName} was not created by me; remove it in YouTube Studio.`);
            return;
        }
        const gate = await this.actionGate(message, 'unban', resolved.target, reason, LIVE_CHAT_BAN_COST, false);
        if (!gate) return;
        this.actionsUsed += 1;
        try {
            await this.api.ytCall(this.youtube, (params) => this.youtube.liveChatBans.delete(params), { id: banId },
                { costUnits: LIVE_CHAT_BAN_COST, budget: this.config.quotaBudgetPerDay, method: 'liveChatBans.delete' });
            this.banIds.delete(this.banKey(resolved.target.channelId));
            try { await this.brain?.deleteYtBan?.(this.videoId, resolved.target.channelId); }
            catch (error) { this.persistenceFailed(error); }
            await this.audit(message, 'unban', resolved.target, reason, 'SUCCESS', { banId });
            this.reply(`unbanned ${resolved.target.displayName}.`);
        } catch (error) { await this.actionFailure(message, 'unban', resolved.target, reason, error); }
    }

    async deleteMessages(message, args) {
        const resolved = await this.resolveTarget(args, message, 'delete');
        if (!resolved) return;
        let count = 1;
        const tail = resolved.tail.trim();
        if (tail) {
            if (!/^\d+$/.test(tail)) {
                await this.audit(message, 'delete', resolved.target, '', 'FAILED', { failureReason: 'count must be a number' });
                this.reply('delete count must be a number from 1 to 10.'); return;
            }
            count = Math.max(1, Math.min(MAX_DELETE_COUNT, Number(tail)));
        }
        const ids = this.cache.recentMessageIds(resolved.target.channelId, count);
        if (!ids.length) {
            await this.audit(message, 'delete', resolved.target, '', 'FAILED', { failureReason: 'no cached messages for target' });
            this.reply(`no recent messages from ${resolved.target.displayName} are cached.`); return;
        }
        let deleted = 0;
        for (const id of ids) {
            const gate = await this.actionGate(message, 'delete', resolved.target, '', LIVE_CHAT_MESSAGE_DELETE_COST, false);
            if (!gate) break;
            this.actionsUsed += 1;
            try {
                await this.api.ytCall(this.youtube, (params) => this.youtube.liveChatMessages.delete(params), { id },
                    { costUnits: LIVE_CHAT_MESSAGE_DELETE_COST, budget: this.config.quotaBudgetPerDay, method: 'liveChatMessages.delete' });
                deleted += 1;
            } catch (error) {
                await this.actionFailure(message, 'delete', resolved.target, '', error);
                break;
            }
        }
        if (deleted) {
            await this.audit(message, 'delete', resolved.target, '', 'SUCCESS', { count: deleted });
            this.reply(`deleted ${deleted} recent message${deleted === 1 ? '' : 's'} from ${resolved.target.displayName}.`);
        }
    }

    async actionGate(message, action, target, reason, cost, banCooldown) {
        if (this.actionsUsed >= this.maxActions) {
            await this.audit(message, action, target, reason, 'FAILED', { failureReason: 'per-stream moderation action cap reached' });
            this.reply('stream moderation action limit reached.');
            return false;
        }
        if (banCooldown && this.lastBanActionAt !== null && this.clock() - this.lastBanActionAt < this.actionCooldown) {
            await this.audit(message, action, target, reason, 'FAILED', { failureReason: 'ban/timeout cooldown active' });
            this.reply('please wait a moment before another ban or timeout.');
            return false;
        }
        if (this.api.quotaRemaining() - cost - CHAT_REPLY_COST < this.reserve) {
            this.quotaStopped = true;
            await this.audit(message, action, target, reason, 'FAILED', { failureReason: 'moderation quota reserve reached', quotaCost: cost, reserve: this.reserve });
            if (!this.quotaNotice) { this.quotaNotice = true; this.onNotice('YouTube moderation paused because the configured quota reserve was reached.'); }
            this.reply('not enough quota left to safely do that.', true);
            return false;
        }
        return true;
    }

    async actionFailure(message, action, target, reason, error) {
        const kind = error?.yt?.kind || this.api.classifyYouTubeError(error);
        await this.audit(message, action, target, reason, 'FAILED', { errorKind: kind, failureReason: error?.message || kind });
        if (kind === this.api.KIND.FORBIDDEN) {
            this.forbiddenBlocked = true;
            if (!this.forbiddenNotice) {
                this.forbiddenNotice = true;
                this.onNotice('YouTube moderation paused: bot channel is not a live-chat moderator.');
                this.reply('I need to be added as a moderator to do that.', true);
            }
        } else if (kind === this.api.KIND.AUTH) {
            this.authBlocked = true;
            if (!this.authNotice) { this.authNotice = true; this.onNotice('YouTube moderation paused because YouTube authorization failed.'); }
            this.reply('YouTube authorization failed; moderation is paused.', true);
        } else if (kind === this.api.KIND.QUOTA) {
            this.quotaStopped = true;
            if (!this.quotaNotice) { this.quotaNotice = true; this.onNotice('YouTube moderation paused because quota is exhausted.'); }
            this.reply('YouTube quota is exhausted; moderation is paused.', true);
        } else {
            this.reply('that moderation action failed; no automatic retry will be made.', true);
        }
    }

    banKey(channelId) { return `${this.videoId}:${channelId}`; }

    async storeBan(target, banId) {
        this.banIds.set(this.banKey(target.channelId), String(banId));
        try { await this.brain?.recordYtBan?.(this.videoId, target.channelId, String(banId), target.displayName); }
        catch (error) { this.persistenceFailed(error); }
    }

    persistenceFailed(error) {
        if (this.persistenceNotice) return;
        this.persistenceNotice = true;
        this.onNotice('YouTube ban persistence unavailable; in-memory tracking only (MongoDB unavailable).');
    }

    async setEnabled(enabled, { allowForbiddenRecovery = false } = {}) {
        this.enabled = Boolean(enabled);
        this.config.moderationEnabled = this.enabled;
        if (this.enabled && allowForbiddenRecovery) {
            this.forbiddenBlocked = false;
            this.forbiddenNotice = false;
        }
        return this.enabled;
    }

    async stop() {
        if (this.pendingBan) await this.expirePendingBan();
    }
}

module.exports = {
    YouTubeCommandRouter, parseTargetAndTail,
    LIVE_CHAT_BAN_COST, LIVE_CHAT_MESSAGE_DELETE_COST, CHAT_REPLY_COST,
    DEFAULT_MOD_QUOTA_RESERVE, DEFAULT_MAX_MOD_ACTIONS_PER_STREAM,
    DEFAULT_MOD_ACTION_COOLDOWN_MS, BAN_CONFIRMATION_MS, MAX_DELETE_COUNT,
    TEMP_BAN_MINUTES, TEMP_BAN_MAX_MINUTES
};
