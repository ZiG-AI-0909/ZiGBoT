/**
 * Per-reply memory lookups, kept out of src/index.js so the decisions are
 * testable. Each resolver returns an explicit state the prompt reports
 * truthfully; a failure is never turned into "nothing stored".
 */

// state: unavailable | server_off | off | failed | none | retrieved
async function resolvePersonalMemory({ brain, guildId, userId, memoryAllowed, limit = 5 }) {
    if (!guildId || !brain.isMemoryAvailable()) return { state: 'unavailable', memories: null };
    if (!memoryAllowed) return { state: 'server_off', memories: null };
    try {
        const personal = await brain.recallIfEnabled(guildId, userId, limit);
        if (!personal.enabled) return { state: 'off', memories: null };
        return personal.memories.length > 0
            ? { state: 'retrieved', memories: personal.memories }
            : { state: 'none', memories: [] };
    } catch (error) {
        // Preference or recall failure: fail closed, and say so.
        console.error(`[ZiGBoT MEMORY] Recall failed: ${error?.code || error?.name || 'Error'}`);
        return { state: 'failed', memories: null };
    }
}

// Memories other members explicitly shared with this server.
// state: skipped | failed | none | included
// isAuthorAllowed(userId) lets the caller drop authors who left the server or
// whose roles no longer allow memory; it is applied after the database filter.
async function resolveSharedMemory({ brain, guildId, excludeUserId, allowed, isAuthorAllowed = () => true, limit = 8 }) {
    if (!allowed || !guildId || !brain.isMemoryAvailable()) return { state: 'skipped', memories: null };
    try {
        const shared = (await brain.recallShared(guildId, { excludeUserId, limit }))
            .filter((memory) => isAuthorAllowed(memory.userId));
        return shared.length > 0 ? { state: 'included', memories: shared } : { state: 'none', memories: [] };
    } catch (error) {
        console.error(`[ZiGBoT MEMORY] Shared lookup failed: ${error?.code || error?.name || 'Error'}`);
        return { state: 'failed', memories: null };
    }
}

const MEMORY_OFF_REPLY = 'You turned personal memory off in this server, so I am not using anything stored about you. `/memory view` shows what is still stored (it expires after 30 days), `/memory clear` deletes it, and `/memory on` turns memory back on.';
const MEMORY_SERVER_OFF_REPLY = 'Long-term memory is turned off for you in this server, so I am not storing or recalling anything about you here.';

// Public-channel answer to "what do you remember about me?". Reads the
// preference and a COUNT only: memory text is never even fetched here.
async function memoryQuestionReply({ brain, guildId, userId, memoryAllowed }) {
    // Required lazily: client.js pulls in the AI provider stack.
    const { buildMemoryAnswer } = require('../ai/client');
    if (!memoryAllowed) return MEMORY_SERVER_OFF_REPLY;
    const capabilities = brain.getMemoryCapabilities();
    if (!capabilities.persistentMemory) return buildMemoryAnswer({ capabilities });
    try {
        const preference = await brain.getMemoryPreference(guildId, userId);
        if (!preference.enabled) return MEMORY_OFF_REPLY;
        return buildMemoryAnswer({ capabilities, count: await brain.countMemories(guildId, userId) });
    } catch (error) {
        // Preference or count failure: say so; never guess.
        console.error(`[ZiGBoT MEMORY] Memory question lookup failed: ${error?.code || error?.name || 'Error'}`);
        return buildMemoryAnswer({ capabilities, count: null });
    }
}

module.exports = { resolvePersonalMemory, resolveSharedMemory, memoryQuestionReply, MEMORY_OFF_REPLY, MEMORY_SERVER_OFF_REPLY };
