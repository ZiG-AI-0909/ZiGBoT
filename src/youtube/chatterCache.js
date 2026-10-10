const DEFAULT_RETENTION_MS = 30 * 60 * 1000;

function normalizeDisplayName(value) {
    return String(value || '').replace(/[\u200B-\u200D\u2060\uFEFF]/g, '').trim().replace(/^@+/, '').trim().toLocaleLowerCase();
}

class ChatterCache {
    constructor({ clock = () => Date.now(), retentionMs = DEFAULT_RETENTION_MS } = {}) {
        this.clock = clock;
        this.retentionMs = retentionMs;
        this.chatters = new Map();
    }

    prune() {
        const cutoff = this.clock() - this.retentionMs;
        for (const [channelId, chatter] of this.chatters) {
            chatter.messages = chatter.messages.filter((message) => message.at >= cutoff);
            if (chatter.lastSeen < cutoff) this.chatters.delete(channelId);
        }
    }

    record(message) {
        const author = message?.author || {};
        const channelId = String(author.channelId || '');
        if (!channelId || !message?.id) return;
        this.prune();
        let chatter = this.chatters.get(channelId);
        if (!chatter) {
            chatter = { channelId, displayName: String(author.displayName || channelId), normalizedName: normalizeDisplayName(author.displayName),
                protected: false, isBot: false, lastSeen: 0, messages: [] };
            this.chatters.set(channelId, chatter);
        }
        if (author.displayName) {
            chatter.displayName = String(author.displayName);
            chatter.normalizedName = normalizeDisplayName(author.displayName);
        }
        chatter.protected = chatter.protected || Boolean(author.isChatOwner || author.isChatModerator);
        chatter.isBot = chatter.isBot || Boolean(author.isBot);
        chatter.lastSeen = this.clock();
        if (!chatter.messages.some((entry) => entry.id === String(message.id))) {
            chatter.messages.push({ id: String(message.id), at: chatter.lastSeen });
        }
        return chatter;
    }

    byChannelId(channelId) {
        this.prune();
        return this.chatters.get(String(channelId)) || null;
    }

    findByName(name) {
        this.prune();
        const normalized = normalizeDisplayName(name);
        return [...this.chatters.values()].filter((chatter) => chatter.normalizedName === normalized);
    }

    recentMessageIds(channelId, count = 1) {
        const chatter = this.byChannelId(channelId);
        return chatter ? chatter.messages.slice(-count).reverse().map(({ id }) => id) : [];
    }
}

module.exports = { ChatterCache, normalizeDisplayName, DEFAULT_RETENTION_MS };
