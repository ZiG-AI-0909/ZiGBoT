const YT_API = require('./apiClient');

// Reply policy. Values can be overridden by the corresponding YOUTUBE_* envs.
const GREETING_MAX_WORDS = 6;
const BACKLOG_TOLERANCE_MS = 3_000;
const GLOBAL_SEND_INTERVAL_MS = 5_000;
const MAX_PENDING_REPLIES = 10;
const MENTION_COOLDOWN_MS = 60_000;
const DEFAULT_QUOTA_RESERVE = 2_500;
const DEFAULT_MAX_REPLIES_PER_STREAM = 60;
const PERSISTENCE_TTL_SECONDS = 24 * 60 * 60;
const IGNORED_BOT_NAMES = new Set(['nightbot', 'streamelements', 'streamlabs', 'moobot']);

const GREETING_TEMPLATES = [
    'Hey {name}, welcome to the stream 👋', 'Hi {name}! Glad you’re here 😊',
    'Hello {name}, enjoy the stream!', 'Yo {name}, welcome in ✨',
    'Namaste {name}! Thanks for joining 🙏', 'Heyy {name}, hope you enjoy!',
    'Hola {name}! Welcome aboard 👋', 'Good to have you here, {name} 💙'
];
const MENTION_TEMPLATES = [
    'Hey {name}, I’m here 👋', 'Yep {name}? 😊',
    'Hi {name}, thanks for the shout!', 'What’s up {name}? ✨'
];

function normalize(text) {
    return String(text || '').normalize('NFKC').toLocaleLowerCase()
        .replace(/[\p{P}\p{S}\p{C}]/gu, ' ').replace(/\s+/g, ' ').trim();
}

function isGreeting(text, maxWords = GREETING_MAX_WORDS) {
    if (/^\s*!/.test(String(text || ''))) return false;
    const words = normalize(text).split(' ').filter(Boolean);
    if (!words.length || words.length > maxWords) return false;
    const initial = words[0];
    if (['hello', 'helo', 'hlo', 'hey', 'yo', 'sup', 'namaste', 'namaskar', 'नमस्ते', 'hola', 'gm'].includes(initial)) return true;
    if (/^h+i+$/.test(initial) && initial.length >= 2) return true;
    if (/^he+y+$/.test(initial)) return true;
    return ['good morning', 'good afternoon', 'good evening'].some((phrase) => normalize(text).startsWith(phrase));
}

function safeName(displayName) {
    const name = String(displayName || 'there').replace(/[\p{Cc}\p{Cf}\r\n]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 40);
    return name || 'there';
}

function mentionsBot(text, botTitle, fallbackName) {
    const source = String(text || '').toLocaleLowerCase();
    const names = [botTitle, fallbackName].filter(Boolean).map((n) => String(n).trim()).filter(Boolean);
    return names.some((name) => {
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(`@\\s*${escaped}(?![\\p{L}\\p{N}_])`, 'iu').test(source)
            || new RegExp(`(?:^|[^\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, 'iu').test(source);
    });
}

class Greetings {
    constructor({ youtube, liveChatId, videoId, config = {}, selfId, ownerId, botTitle, brain = null,
        clock = () => Date.now(), random = Math.random, setTimer = setTimeout, clearTimer = clearTimeout,
        onNotice = () => {}, api = YT_API } = {}) {
        this.youtube = youtube; this.liveChatId = liveChatId; this.videoId = videoId; this.config = config;
        this.selfId = selfId; this.ownerId = ownerId; this.botTitle = botTitle; this.brain = brain;
        this.clock = clock; this.random = random; this.setTimer = setTimer; this.clearTimer = clearTimer;
        this.onNotice = onNotice; this.api = api; this.enabled = Boolean(config.greetingsEnabled);
        this.greeted = new Set(); this.seen = new Set(); this.mentionAt = new Map();
        this.queue = []; this.sending = false; this.lastSentAt = null; this.repliesSent = 0; this.messagesSent = 0;
        this.previousTemplate = null; this.disabledNotice = false; this.reserveNotice = false;
        this.capNotice = false; this.persistenceNotice = false; this.timer = null;
        this.maxReplies = Number.isFinite(config.maxRepliesPerStream) ? config.maxRepliesPerStream : DEFAULT_MAX_REPLIES_PER_STREAM;
        this.reserve = Number.isFinite(config.quotaReserve) ? config.quotaReserve : DEFAULT_QUOTA_RESERVE;
        this.maxWords = Number(config.greetingMaxWords) || GREETING_MAX_WORDS;
        this.backlogTolerance = Number.isFinite(config.backlogToleranceMs) ? config.backlogToleranceMs : BACKLOG_TOLERANCE_MS;
        this.outgoingInterval = Number.isFinite(config.outgoingIntervalMs) ? config.outgoingIntervalMs : GLOBAL_SEND_INTERVAL_MS;
        this.maxPending = Number.isFinite(config.maxPendingReplies) ? config.maxPendingReplies : MAX_PENDING_REPLIES;
        this.mentionCooldown = Number.isFinite(config.mentionCooldownMs) ? config.mentionCooldownMs : MENTION_COOLDOWN_MS;
        this.ready = this.loadPersisted();
    }

    async loadPersisted() {
        try {
            if (this.brain?.listYtGreetedViewers) {
                for (const id of await this.brain.listYtGreetedViewers(this.videoId)) this.greeted.add(String(id));
            }
        } catch (error) { this.persistenceFailed(error); }
    }

    persistenceFailed(error) {
        if (this.persistenceNotice) return;
        this.persistenceNotice = true;
        this.onNotice(`YouTube greeting persistence unavailable; using in-memory limits (${error?.message || 'MongoDB unavailable'}).`);
    }

    async handle(message) {
        try { await this.ready; } catch (_) { /* loadPersisted already reports best-effort failure */ }
        if (!this.enabled || !message?.id || this.seen.has(message.id)
            || (message.eventType && message.eventType !== 'textMessageEvent')) return false;
        this.seen.add(message.id);
        if (message.watcherStartedAt && Date.parse(message.publishedAt || '') < message.watcherStartedAt - this.backlogTolerance) return false;
        const author = message.author || {};
        if (!author.channelId || author.channelId === this.selfId || author.channelId === this.ownerId
            || author.isChatModerator || author.isChatOwner
            || (this.config.ignoredChannelIds || []).includes(author.channelId)
            || IGNORED_BOT_NAMES.has(String(author.displayName || '').trim().toLocaleLowerCase())) return false;
        if (String(message.text || '').trimStart().startsWith(this.config.commandPrefix || '!')) return false;
        const mention = mentionsBot(message.text, this.botTitle, this.config.botName || 'ZiGBoT');
        const greeting = isGreeting(message.text, this.maxWords);
        if (!mention && !greeting) return false;
        if (greeting && !mention && this.greeted.has(author.channelId)) return false;
        const now = this.clock();
        if (mention && now - (this.mentionAt.get(author.channelId) ?? -Infinity) < this.mentionCooldown) return false;
        if (this.queue.length + Number(this.sending) >= this.maxPending) return false;
        const type = mention ? 'mention' : 'greeting';
        if (greeting && !mention && this.roastMode?.mode) {
            this.greeted.add(author.channelId);
            const result = await this.roastMode.roast({ ...author, channelId: author.channelId }, 'roast-mode greeting', message);
            if (result.ok) return true;
            // A failed or filtered roast falls back to a friendly template. A crisis
            // still receives only a friendly greeting; it is never sent to the model.
        }
        const text = this.makeReply(type, safeName(author.displayName));
        this.queue.push({ type, channelId: author.channelId, text });
        if (type === 'mention') this.mentionAt.set(author.channelId, now);
        else this.greeted.add(author.channelId);
        this.pump();
        return true;
    }

    makeReply(type, name) {
        const templates = type === 'mention' ? MENTION_TEMPLATES : GREETING_TEMPLATES;
        let index = Math.floor(this.random() * templates.length) % templates.length;
        if (templates.length > 1 && index === this.previousTemplate) index = (index + 1) % templates.length;
        this.previousTemplate = index;
        return templates[index].replace('{name}', name).slice(0, 199);
    }

    enqueueText(text, { quotaReserve = this.reserve } = {}) {
        return this.enqueueChatText(text, { quotaReserve, type: 'moderation' });
    }

    enqueueChatText(text, { quotaReserve = this.reserve, type = 'moderation', onSent = null, onFailed = null } = {}) {
        const messageText = String(text || '').replace(/[\p{Cc}\p{Cf}\r\n]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 199);
        if (!messageText || this.queue.length + Number(this.sending) >= this.maxPending) return false;
        this.queue.push({ type, channelId: null, text: messageText, quotaReserve, onSent, onFailed });
        this.pump();
        return true;
    }

    setGreetingsEnabled(enabled) {
        this.enabled = Boolean(enabled);
        if (!this.enabled) {
            this.queue = this.queue.filter((item) => ['moderation', 'roast'].includes(item.type));
            if (this.timer) this.clearTimer(this.timer);
            this.timer = null;
        }
        if (this.queue.length) this.pump();
    }

    async pump() {
        if (this.sending || !this.queue.length) return;
        if (!this.enabled && !['moderation', 'roast'].includes(this.queue[0].type)) return;
        const wait = this.lastSentAt === null ? 0 : this.outgoingInterval - (this.clock() - this.lastSentAt);
        if (wait > 0) {
            this.timer = this.setTimer(() => { this.timer = null; this.pump(); }, wait);
            return;
        }
        this.sending = true;
        const reply = this.queue.shift();
        try {
            if (['greeting', 'mention'].includes(reply.type) && this.repliesSent >= this.maxReplies) {
                this.queue = this.queue.filter((item) => ['moderation', 'roast'].includes(item.type));
                if (typeof reply.onFailed === 'function') await reply.onFailed('greeting reply cap reached');
                if (!this.capNotice) { this.capNotice = true; this.onNotice('YouTube reply cap reached for this stream; replies paused until the next stream.'); }
                return;
            }
            if (this.api.quotaRemaining() - 20 < (reply.quotaReserve ?? this.reserve)) {
                const minimumReserve = reply.quotaReserve ?? this.reserve;
                const retained = [];
                for (const item of this.queue) {
                    if (['moderation', 'roast'].includes(item.type) && (item.quotaReserve ?? this.reserve) < minimumReserve) retained.push(item);
                    else await this.failQueuedItem(item, 'quota reserve reached before send');
                }
                this.queue = retained;
                if (typeof reply.onFailed === 'function') await reply.onFailed('quota reserve reached before send');
                if (!this.reserveNotice) { this.reserveNotice = true; this.onNotice('YouTube replies paused to preserve the configured API quota reserve.'); }
                return;
            }
            await this.api.ytCall(this.youtube, (params) => this.youtube.liveChatMessages.insert(params), {
                part: 'snippet', requestBody: { snippet: { liveChatId: this.liveChatId, type: 'textMessageEvent', textMessageDetails: { messageText: reply.text } } }
            }, { costUnits: 20, budget: this.config.quotaBudgetPerDay });
            if (['greeting', 'mention'].includes(reply.type)) this.repliesSent += 1;
            this.messagesSent += 1;
            if (typeof reply.onSent === 'function') await reply.onSent();
            this.lastSentAt = this.clock();
            if (reply.type === 'greeting') {
                try { await this.brain?.recordYtGreetedViewer?.(this.videoId, reply.channelId); }
                catch (error) { this.persistenceFailed(error); }
            }
        } catch (error) {
            const kind = error?.yt?.kind || this.api.classifyYouTubeError(error);
            if (typeof reply.onFailed === 'function') await reply.onFailed(`YouTube send failed (${kind})`);
            if ([this.api.KIND.FORBIDDEN, this.api.KIND.AUTH].includes(kind)) {
                this.enabled = false;
                await this.failQueued('YouTube sending is disabled for this stream');
                if (!this.disabledNotice) {
                    this.disabledNotice = true;
                    this.onNotice(`YouTube greeting replies disabled for this stream (${kind}); the bot channel may not be allowed to post in this chat.`);
                }
            } else if (kind === this.api.KIND.QUOTA) {
                await this.failQueued('YouTube quota exhausted');
                if (!this.reserveNotice) { this.reserveNotice = true; this.onNotice('YouTube greeting replies paused because the API quota is exhausted.'); }
            }
            // Transient send failures drop this reply; the chat reader continues.
        } finally {
            this.sending = false;
            if (this.queue.length && (this.enabled || ['moderation', 'roast'].includes(this.queue[0].type))) this.pump();
        }
    }

    async failQueuedItem(item, reason) {
        if (typeof item?.onFailed !== 'function') return;
        try { await item.onFailed(reason); } catch { /* queue cleanup must stay safe */ }
    }

    async failQueued(reason) {
        const pending = this.queue.splice(0);
        await Promise.all(pending.map((item) => this.failQueuedItem(item, reason)));
    }

    stop() {
        if (this.timer) this.clearTimer(this.timer);
        this.timer = null;
        void this.failQueued('YouTube watcher stopped');
    }
}

module.exports = {
    Greetings, isGreeting, mentionsBot, safeName, GREETING_TEMPLATES, MENTION_TEMPLATES,
    GREETING_MAX_WORDS, BACKLOG_TOLERANCE_MS, GLOBAL_SEND_INTERVAL_MS, MAX_PENDING_REPLIES,
    MENTION_COOLDOWN_MS, DEFAULT_QUOTA_RESERVE, DEFAULT_MAX_REPLIES_PER_STREAM
};
