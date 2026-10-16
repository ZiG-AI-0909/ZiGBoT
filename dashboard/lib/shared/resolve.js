/**
 * Role-based behaviour resolution with a predictable precedence:
 *
 *  1. Only mappings for roles the member ACTUALLY has (role IDs from Discord,
 *     never from user input) are considered.
 *  2. They are ordered by `priority` (high -> low), then by Discord role
 *     position (high -> low), then by role id — fully deterministic.
 *  3. Tone and pronouns come from the first ordered mapping that sets them,
 *     otherwise the server default tone.
 *  4. Features = defaults ∪ every matched `allowed_features`, then MINUS every
 *     matched `denied_features` (deny always wins), then minus anything the
 *     server switched off globally.
 *  5. Instructions from all matched mappings are included, in order.
 *
 * Features only influence what the bot will do; they never grant Discord
 * permissions. Privileged tools additionally require the member's real
 * Discord permission (checked in the bot's router).
 */
const { DEFAULT_MEMBER_FEATURES, LIMITS } = require('./constants');

function orderMappings(mappings, memberRoleIds, rolePositions = new Map()) {
    const owned = new Set((memberRoleIds || []).map(String));
    return (mappings || [])
        .filter((mapping) => owned.has(String(mapping.role_id)))
        .sort((a, b) => (b.priority || 0) - (a.priority || 0)
            || (rolePositions.get(String(b.role_id)) || 0) - (rolePositions.get(String(a.role_id)) || 0)
            || String(a.role_id).localeCompare(String(b.role_id)));
}

function resolveMemberBehavior({ config, mappings = [], memberRoleIds = [], rolePositions } = {}) {
    const cfg = config || {};
    const matched = orderMappings(mappings, memberRoleIds, rolePositions);

    let tone = matched.find((m) => m.tone)?.tone || cfg.default_tone || 'gentle';
    const pronouns = matched.find((m) => m.pronouns)?.pronouns || null;

    const features = new Set(DEFAULT_MEMBER_FEATURES);
    if (tone === 'savage' || cfg.default_tone === 'savage') features.add('roast');
    for (const mapping of matched) for (const f of mapping.allowed_features || []) features.add(f);
    for (const mapping of matched) for (const f of mapping.denied_features || []) features.delete(f);
    if (cfg.memory_enabled === false) features.delete('memory');
    if (cfg.music_enabled === false) features.delete('music');
    if (cfg.voice_enabled === false) features.delete('voice');

    // A savage tone without the roast feature degrades to gentle.
    if (tone === 'savage' && !features.has('roast')) tone = 'gentle';

    const instructions = [];
    let budget = LIMITS.roleInstructions * 2;
    for (const mapping of matched) {
        const text = String(mapping.instructions || '').trim();
        if (!text || budget <= 0) continue;
        instructions.push(text.slice(0, budget));
        budget -= text.length;
    }

    return {
        tone,
        pronouns,
        instructions,
        features,
        primary: matched[0] || null,
        matchedRoleIds: matched.map((m) => String(m.role_id))
    };
}

function hasFeature(behavior, feature) {
    if (!behavior) return true; // legacy mode: no feature gating
    return behavior.features instanceof Set ? behavior.features.has(feature) : false;
}

module.exports = { resolveMemberBehavior, orderMappings, hasFeature };
