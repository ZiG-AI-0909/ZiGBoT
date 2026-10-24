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
    if (preference !== 'on') return buildOwnerMemoryAnswer({ targetName, preference });
    // Saved memories and automatic summaries are counted separately.
    const totalCount = await brain.countMemories(guildId, userId, { excludeSource: 'summary' });
    const summaryCount = await brain.countMemories(guildId, userId, { source: 'summary' });
    return buildOwnerMemoryAnswer({ targetName, totalCount, summaryCount, preference });
}

module.exports = { ownerMemoryStatus };
