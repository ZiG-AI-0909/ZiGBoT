/**
 * Who is AFK, per server. Every message checks this, so lookups come from
 * an in-memory copy (no database query per message); MongoDB (collection
 * `afk`, one document per server+user) makes it survive restarts.
 *
 * A database error is logged and never loses the status: the in-memory
 * copy is kept, and the next change writes again. Without a database at
 * all, AFK still works until the bot restarts.
 */
function createAfkStore({ getCollection, logger = console }) {
    const cache = new Map();
    const key = (guildId, userId) => `${guildId}:${userId}`;
    const fail = (what, error) => logger.error(`[ZiGBoT AFK] ${what} failed: ${error?.message || error}`);

    return {
        /** Fill the cache from MongoDB (call once after the database connects). */
        async load() {
            const collection = getCollection();
            if (!collection) return 0;
            try {
                const docs = await collection.find({}).toArray();
                for (const doc of docs) cache.set(key(doc.guildId, doc.userId), {
                    guildId: doc.guildId, userId: doc.userId, reason: doc.reason, since: doc.since,
                    originalNick: doc.originalNick ?? null, afkNick: doc.afkNick ?? null
                });
                return docs.length;
            } catch (error) {
                fail('load', error);
                return 0;
            }
        },

        get(guildId, userId) {
            const record = cache.get(key(guildId, userId));
            return record ? { ...record } : null;
        },

        async set(record) {
            const value = {
                guildId: String(record.guildId), userId: String(record.userId), reason: record.reason, since: record.since,
                originalNick: record.originalNick ?? null, afkNick: record.afkNick ?? null
            };
            cache.set(key(value.guildId, value.userId), value);
            const collection = getCollection();
            if (!collection) return;
            try {
                await collection.updateOne(
                    { guildId: value.guildId, userId: value.userId },
                    { $set: { reason: value.reason, since: value.since, originalNick: value.originalNick, afkNick: value.afkNick } },
                    { upsert: true }
                );
            } catch (error) {
                fail('save', error);
            }
        },

        async remove(guildId, userId) {
            cache.delete(key(guildId, userId));
            const collection = getCollection();
            if (!collection) return;
            try {
                await collection.deleteOne({ guildId: String(guildId), userId: String(userId) });
            } catch (error) {
                fail('remove', error);
            }
        },

        size: () => cache.size
    };
}

module.exports = { createAfkStore };
