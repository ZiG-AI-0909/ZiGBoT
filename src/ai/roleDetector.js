function normalizeRoleName(name) {
    if (!name || typeof name !== 'string') return '';
    return name
        .normalize('NFKD')
        .toLowerCase()
        .replace(/[\u0300-\u036f]/g, '') // remove diacritics
        .replace(/[^a-z0-9]/g, '');      // strip all symbols/spaces
}

function isGentleMember(member, configuredGentleRoles = [], guildId = '') {
    if (!member || !member.roles || !member.roles.cache) {
        return false;
    }

    // Build normalized set of configured gentle roles + keywords
    const normalizedGentleSet = new Set(
        configuredGentleRoles.map(normalizeRoleName).filter(Boolean)
    );

    const primaryGuild = member.user?.primaryGuild;
    const serverTag = primaryGuild?.tag;
    const isCurrentGuildTag = !guildId || primaryGuild.identityGuildId === guildId;
    if (primaryGuild?.identityEnabled && serverTag && isCurrentGuildTag) {
        const normalizedTag = normalizeRoleName(serverTag);
        if (configuredGentleRoles.some((roleName) => normalizeRoleName(roleName).includes(normalizedTag))) {
            return true;
        }
    }

    // Standard fallback normalized keywords (both female and male gentle roles)
    const gentleKeywords = [
        // Female gentle roles
        'sheher', 'shehers', 'girl', 'girls', 'female', 'females',
        'queen', 'queens', 'princess',
        // Male gentle roles
        'gentleman', 'gentlemen', 'king', 'kings', 'softboy', 'softboys',
        'chillguy', 'chillbro', 'chillboy', 'goodguy', 'wholesomeboy', 'homie',
        // General gentle roles
        'gentle', 'gentlemode', 'wholesome', 'softie', 'soft', 'peaceful'
    ];

    for (const kw of gentleKeywords) {
        normalizedGentleSet.add(kw);
    }

    // Check member's roles
    for (const role of member.roles.cache.values()) {
        const rawLower = role.name.toLowerCase().trim();
        const normalized = normalizeRoleName(role.name);

        // Direct check against configured gentle roles
        if (configuredGentleRoles.some((gr) => gr.toLowerCase().trim() === rawLower)) {
            return true;
        }

        // Normalized check (e.g. "ｓｈｅ ﹒ ｈｅｒ", "ｇｅｎｔｌｅｍａｎ", "ｓｏｆｔ ｂｏｙ", etc.)
        if (normalizedGentleSet.has(normalized)) {
            return true;
        }

        // Substring checks for compound roles like "she/her | gamer", "Chill Guy | VIP", "Gentleman | Staff"
        if (
            normalized.includes('sheher') ||
            normalized.includes('female') ||
            normalized.includes('girl') ||
            normalized.includes('queen') ||
            normalized.includes('princess') ||
            normalized.includes('gentleman') ||
            normalized.includes('softboy') ||
            normalized.includes('chillguy') ||
            normalized.includes('chillbro') ||
            normalized.includes('wholesome') ||
            normalized.includes('gentle')
        ) {
            return true;
        }
    }

    return false;
}

module.exports = {
    normalizeRoleName,
    isGentleMember
};
