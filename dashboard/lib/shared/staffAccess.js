/**
 * Dashboard staff access by role (Section K), READ-ONLY.
 *
 * Admins (owner / Administrator / Manage Server) keep the unchanged full
 * access of decideGuildAccess. A member WITHOUT those permissions but with
 * one of the server's configured dashboard staff roles gets read-only staff
 * access: the staff page, through server-side reads only. Staff access never
 * creates a zb_guild_admins row (that row is what lets row-level security
 * accept direct table writes), so a staff member can never write settings,
 * not even through the Supabase API directly.
 *
 * Inputs must be trusted: Discord data fetched server-side with the bot
 * token, and staff roles read from the stored config. CommonJS for tests.
 */
const { decideGuildAccess } = require('./access');

const SNOWFLAKE = /^\d{17,20}$/;

function decideStaffAccess({ guild, member, discordUserId, staffRoleIds = [] }) {
    const admin = decideGuildAccess({ guild, member, discordUserId });
    if (admin.allowed) return { ...admin, staff: false, readOnly: false };
    // Only "has no admin permission" can be upgraded; identity, membership
    // and bot-missing failures stay failures.
    if (admin.code !== 'missing_permission') return { ...admin, staff: false };
    const roles = new Set((member?.roles || []).map(String));
    const staffRoles = (Array.isArray(staffRoleIds) ? staffRoleIds : []).map(String).filter((id) => SNOWFLAKE.test(id) && id !== String(guild?.id));
    if (staffRoles.some((id) => roles.has(id))) {
        return { allowed: true, status: 200, code: 'staff', staff: true, readOnly: true, isOwner: false };
    }
    return { ...admin, staff: false };
}

module.exports = { decideStaffAccess };
