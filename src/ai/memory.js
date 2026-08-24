class ConversationMemory {
    constructor(options = {}) {
        this.maxMessages = options.maxMessages || 8;
        this.ttlMs = options.ttlMs || 15 * 60 * 1000; // 15 minutes
        this.channels = new Map();
    }

    addMessage(channelId, role, content, name = '') {
        if (!channelId || !content) return;
        const now = Date.now();
        let history = this.channels.get(channelId) || [];

        // Filter out expired messages
        history = history.filter((msg) => now - msg.timestamp < this.ttlMs);

        history.push({
            role,
            content: content.trim(),
            name: name ? name.trim().slice(0, 32) : undefined,
            timestamp: now
        });

        // Keep within max message window
        if (history.length > this.maxMessages) {
            history = history.slice(history.length - this.maxMessages);
        }

        this.channels.set(channelId, history);
    }

    getHistory(channelId) {
        if (!channelId) return [];
        const now = Date.now();
        const history = (this.channels.get(channelId) || [])
            .filter((msg) => now - msg.timestamp < this.ttlMs);
        this.channels.set(channelId, history);
        return history.map(({ role, content, name }) => ({
            role,
            content: name && role === 'user' ? `[${name}]: ${content}` : content
        }));
    }

    clear(channelId) {
        if (channelId) {
            this.channels.delete(channelId);
        } else {
            this.channels.clear();
        }
    }
}

const defaultMemory = new ConversationMemory();

module.exports = {
    ConversationMemory,
    defaultMemory
};
