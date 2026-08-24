function isOwner(requesterId, settings) {
    return Boolean(settings.serverOwnerId) && requesterId === settings.serverOwnerId;
}

function ownerAuthorization(message, settings) {
    if (!settings.serverOwnerId) {
        return { allowed: false, reason: 'SERVER_OWNER_ID is not configured.' };
    }

    if (!isOwner(message.author.id, settings)) {
        return { allowed: false, reason: 'Only the server owner can authorize administrative actions.' };
    }

    if (!message.guild || message.guild.ownerId !== settings.serverOwnerId) {
        return { allowed: false, reason: 'SERVER_OWNER_ID does not match this server owner.' };
    }

    return { allowed: true };
}

function botPermission(guild, permission) {
    const member = guild.members.me;
    if (!member || !member.permissions.has(permission)) {
        return { allowed: false, reason: `ZiGBoT needs the ${permission} permission.` };
    }
    return { allowed: true };
}

module.exports = { isOwner, ownerAuthorization, botPermission };
