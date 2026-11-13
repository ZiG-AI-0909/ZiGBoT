function isOwner(requesterId, settings) {
    return Boolean(settings.serverOwnerId) && requesterId === settings.serverOwnerId;
}

function isServerOwner(message, settings) {
    return Boolean(
        message?.guild &&
        settings?.serverOwnerId &&
        message.author?.id === settings.serverOwnerId &&
        message.guild.ownerId === settings.serverOwnerId
    );
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
    let hasPermission = false;
    try {
        const member = guild?.members?.me || guild?.me;
        hasPermission = Boolean(member?.permissions?.has?.(permission));
    } catch {
        hasPermission = false;
    }
    if (!hasPermission) {
        return { allowed: false, reason: `ZiGBoT needs the ${permission} permission.` };
    }
    return { allowed: true };
}

module.exports = { isOwner, isServerOwner, ownerAuthorization, botPermission };
