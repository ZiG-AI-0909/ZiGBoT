/**
 * Owner "what do you know about @member" lookup: counts and status only.
 * Another member's memory CONTENTS are never read here. A member who turned
 * memory off, or whose preference cannot be verified, gets no count either.
 */
const { buildOwnerMemoryAnswer } = require('../ai/client');

// Resolves to the DM text. Throws only when the count itself fails, so the
// caller can say nothing was delivered.
async function ownerMemoryStatus({ brain, guildId, userId, targetName }) {
    let preference = 'unknown';
    try {
        preference = (await brain.getMemoryPreference(guildId, userId)).enabled ? 'on' : 'off';
    } catch (error) {
        console.error(`[ZiGBoT MEMORY] Owner lookup preference check failed: ${error?.code || error?.name || 'Error'}`);
    }
    const totalCount = preference === 'on' ? await brain.countMemories(guildId, userId) : 0;
    return buildOwnerMemoryAnswer({ targetName, totalCount, preference });
}

module.exports = { ownerMemoryStatus };
