/**
 * Discord permission math computed from TRUSTED data fetched server-side
 * with the bot token (GET /guilds/{id}, GET /guilds/{id}/members/{user}).
 * Never feed this anything the browser sent.
 */
const { PERMISSIONS } = require('./constants');

function toBigInt(value) {
    try {
        return BigInt(value ?? 0);
    } catch {
        return 0n;
    }
}

/**
 * Base guild permissions for a member (channel overwrites are not relevant
 * for "can manage this server").
 * @param {{id:string, owner_id:string, roles:Array<{id:string, permissions:string}>}} guild
 * @param {{user:{id:string}, roles:string[]}} member
 */
function computeBasePermissions(guild, member) {
    if (!guild || !member?.user?.id) return 0n;
    const ALL = (1n << 53n) - 1n;
    if (String(guild.owner_id) === String(member.user.id)) return ALL;

    const roleById = new Map((guild.roles || []).map((role) => [String(role.id), role]));
    // @everyone role id == guild id
    let perms = toBigInt(roleById.get(String(guild.id))?.permissions);
    for (const roleId of member.roles || []) {
        const role = roleById.get(String(roleId));
        if (role) perms |= toBigInt(role.permissions);
    }
    if ((perms & PERMISSIONS.ADMINISTRATOR) === PERMISSIONS.ADMINISTRATOR) return ALL;
    return perms;
}

function hasPermission(perms, bit) {
    return (toBigInt(perms) & bit) === bit;
}

/** Owner, Administrator or Manage Server may manage the bot's configuration. */
function canManageGuild(perms) {
    return hasPermission(perms, PERMISSIONS.ADMINISTRATOR) || hasPermission(perms, PERMISSIONS.MANAGE_GUILD);
}

/** For the OAuth /users/@me/guilds list (permissions arrive as a string). */
function canManageFromOAuthGuild(oauthGuild) {
    if (!oauthGuild) return false;
    if (oauthGuild.owner === true) return true;
    return canManageGuild(oauthGuild.permissions);
}

/**
 * A member's permissions in one channel: base permissions, then the
 * channel's @everyone, role and member overwrites (Discord's documented
 * order). Administrator and the owner keep everything.
 * @param {{permission_overwrites?: Array<{id:string, type:number, allow:string, deny:string}>}} channel
 */
function computeChannelPermissions(guild, member, channel) {
    const ALL = (1n << 53n) - 1n;
    let perms = computeBasePermissions(guild, member);
    if (perms === ALL) return ALL;
    const overwrites = channel?.permission_overwrites || [];
    const apply = (overwrite) => {
        if (!overwrite) return;
        perms &= ~toBigInt(overwrite.deny);
        perms |= toBigInt(overwrite.allow);
    };
    apply(overwrites.find((o) => String(o.id) === String(guild.id)));
    const roles = new Set((member?.roles || []).map(String));
    let allow = 0n;
    let deny = 0n;
    for (const o of overwrites) {
        if (Number(o.type) === 0 && String(o.id) !== String(guild.id) && roles.has(String(o.id))) {
            allow |= toBigInt(o.allow);
            deny |= toBigInt(o.deny);
        }
    }
    perms &= ~deny;
    perms |= allow;
    apply(overwrites.find((o) => Number(o.type) === 1 && String(o.id) === String(member?.user?.id)));
    return perms;
}

module.exports = { computeBasePermissions, computeChannelPermissions, hasPermission, canManageGuild, canManageFromOAuthGuild, toBigInt };
