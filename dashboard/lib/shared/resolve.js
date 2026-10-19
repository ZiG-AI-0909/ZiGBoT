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
const { PREMIUM_ONLY_FEATURES } = require('./premium');

function orderMappings(mappings, memberRoleIds, rolePositions = new Map()) {
    const owned = new Set((memberRoleIds || []).map(String));
    return (mappings || [])
        .filter((mapping) => owned.has(String(mapping.role_id)))
        .sort((a, b) => (b.priority || 0) - (a.priority || 0)
            || (rolePositions.get(String(b.role_id)) || 0) - (rolePositions.get(String(a.role_id)) || 0)
            || String(a.role_id).localeCompare(String(b.role_id)));
}

// /setup age roles. Under 18 beats every other role and setting.
const MINOR_INSTRUCTION = 'This member is UNDER 18. Keep every reply clean, kind and age-appropriate: no roasts, no insults, no swearing, no dark, sexual, romantic or adult humour.';

function hasAnyRole(owned, ids) {
    return (ids || []).some((id) => owned.has(String(id)));
}

function resolveMemberBehavior({ config, mappings = [], memberRoleIds = [], rolePositions, premium = true, isGuildOwner = false } = {}) {
    const cfg = config || {};
    const matched = orderMappings(mappings, memberRoleIds, rolePositions);
    const owned = new Set((memberRoleIds || []).map(String));
    const isMinor = hasAnyRole(owned, cfg.minor_role_ids);
    const isAdult = !isMinor && hasAnyRole(owned, cfg.adult_role_ids);

    // Tone: a role mapping's tone, else 18+ members get roasted, else the server default.
    let tone = matched.find((m) => m.tone)?.tone || (isAdult ? 'savage' : null) || cfg.default_tone || 'gentle';
    // Pronouns: a role mapping, else the /setup gender roles, else the owner's from /setup.
    const pronouns = matched.find((m) => m.pronouns)?.pronouns
        || (hasAnyRole(owned, cfg.female_role_ids) ? 'she/her' : null)
        || (hasAnyRole(owned, cfg.male_role_ids) ? 'he/him' : null)
        || (isGuildOwner ? cfg.owner_pronouns || null : null);

    const features = new Set(DEFAULT_MEMBER_FEATURES);
    if (tone === 'savage' || cfg.default_tone === 'savage') features.add('roast');
    for (const mapping of matched) for (const f of mapping.allowed_features || []) features.add(f);
    for (const mapping of matched) for (const f of mapping.denied_features || []) features.delete(f);
    if (cfg.memory_enabled === false) features.delete('memory');
    if (cfg.music_enabled === false) features.delete('music');
    if (cfg.voice_enabled === false) features.delete('voice');
    // Free servers: Premium-only features are off, whatever a mapping allows.
    if (!premium) for (const f of PREMIUM_ONLY_FEATURES) features.delete(f);

    // Under 18: never roasted, whatever any role or the server default says.
    if (isMinor) features.delete('roast');

    // A savage tone without the roast feature degrades to gentle.
    if (tone === 'savage' && !features.has('roast')) tone = 'gentle';

    const instructions = isMinor ? [MINOR_INSTRUCTION] : [];
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
        isMinor,
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
