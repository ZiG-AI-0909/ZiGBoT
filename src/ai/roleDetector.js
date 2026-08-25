function normalizeRoleName(name) {
    if (!name || typeof name !== 'string') return '';
    return name
        .normalize('NFKD')
        .toLowerCase()
        .replace(/[\u0300-\u036f]/g, '') // remove diacritics
        .replace(/[^a-z0-9]/g, '');      // strip all symbols/spaces
}

function getMemberGender(member, configuredFemaleRoles = [], configuredMaleRoles = []) {
    if (!member?.roles?.cache) return null;

    const femaleRoles = new Set(configuredFemaleRoles.map(normalizeRoleName).filter(Boolean));
    const maleRoles = new Set(configuredMaleRoles.map(normalizeRoleName).filter(Boolean));
    let gender = null;

    for (const role of member.roles.cache.values()) {
        const normalizedRole = normalizeRoleName(role.name);
        if (femaleRoles.has(normalizedRole)) gender = 'female';
        if (maleRoles.has(normalizedRole)) gender = 'male';
    }

    return gender;
}

function isGentleMember(member, configuredGentleRoles = [], guildId = '', configuredNonGentleRoles = []) {
    if (!member || !member.roles || !member.roles.cache) {
        return false;
    }

    // Build normalized set of configured gentle roles + keywords
    const normalizedGentleSet = new Set(
        configuredGentleRoles.map(normalizeRoleName).filter(Boolean)
    );
    const normalizedNonGentleSet = new Set(
        configuredNonGentleRoles.map(normalizeRoleName).filter(Boolean)
    );

    for (const role of member.roles.cache.values()) {
        if (normalizedNonGentleSet.has(normalizeRoleName(role.name))) {
            return false;
        }
    }

    const primaryGuild = member.user?.primaryGuild;
    const serverTag = primaryGuild?.tag;
    const isCurrentGuildTag = !guildId || primaryGuild.identityGuildId === guildId;
    if (primaryGuild?.identityEnabled && serverTag && isCurrentGuildTag) {
        const normalizedTag = normalizeRoleName(serverTag);
        if (configuredGentleRoles.some((roleName) => normalizeRoleName(roleName).includes(normalizedTag))) {
            return true;
        }
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

    }

    return false;
}

module.exports = {
    normalizeRoleName,
    isGentleMember,
    getMemberGender
};
