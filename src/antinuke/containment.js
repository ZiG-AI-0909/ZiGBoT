/**
 * Optional automated containment (off by default, enabled per action in
 * the dashboard). Reversible actions only, and only on strong evidence:
 *  - strip_dangerous_roles: on a CRITICAL incident, remove the roles that
 *    give the actor dangerous permissions (role ids are recorded so admins
 *    can give them back).
 *  - remove_unauthorized_bots: kick (never ban) a bot added with
 *    Administrator by someone who is not the owner or a trusted admin.
 * Never the server owner, never ZiGBoT itself, never anything above
 * ZiGBoT's highest role, never without the Discord permission. Every
 * result is checked against what Discord reports afterwards; a failed or
 * partial action is reported as such, never as success.
 */
const { PermissionFlagsBits } = require('discord.js');
const { dangerousPermissionNames } = require('../../dashboard/lib/shared/antinuke');

const STRIP_RULES = new Set(['mass_delete', 'mass_removal', 'permission_then_destroy']);
const BOT_RULES = new Set(['bot_added_admin']);
const REASON = 'ZiGBoT Anti-Nuke: automatic containment';

const errorCode = (error) => String(error?.code || error?.status || error?.name || 'Error').slice(0, 40);
const result = (status, summary, actions = []) => ({ status, summary, actions });

async function fetchMember(guild, userId) {
    try {
        return await guild.members.fetch({ user: userId, force: true });
    } catch {
        return null;
    }
}

async function stripRoles({ guild, me, incident }) {
    const actorId = incident.actorId;
    if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) return result('skipped', 'ZiGBoT lacks the Manage Roles permission');
    const member = await fetchMember(guild, actorId);
    if (!member) return result('skipped', 'the actor is no longer in the server');
    const dangerous = [...member.roles.cache.values()]
        .filter((role) => String(role.id) !== String(guild.id) && dangerousPermissionNames(role.permissions?.bitfield ?? 0n).length > 0);
    if (dangerous.length === 0) return result('skipped', 'the actor has no roles with dangerous permissions (their permissions may come from elsewhere)');
    const top = me.roles.highest.position;
    const removable = dangerous.filter((role) => !role.managed && role.position < top);
    const blocked = dangerous.filter((role) => !removable.includes(role));
    if (removable.length === 0) {
        return result('skipped', 'the actor\'s dangerous roles are managed by an integration or sit above ZiGBoT\'s highest role', [
            { action: 'remove_roles', targetId: actorId, roleIds: blocked.map((r) => String(r.id)), result: 'skipped' }
        ]);
    }
    const roleIds = removable.map((r) => String(r.id));
    try {
        const updated = await member.roles.remove(roleIds, REASON);
        // Verify against what Discord now reports, not the request.
        const fresh = (await fetchMember(guild, actorId)) || updated;
        const still = roleIds.filter((id) => fresh?.roles?.cache?.has(id));
        const removed = roleIds.filter((id) => !still.includes(id));
        const actions = [{ action: 'remove_roles', targetId: actorId, roleIds: removed, result: removed.length ? 'ok' : 'failed' }];
        if (still.length) actions.push({ action: 'remove_roles', targetId: actorId, roleIds: still, result: 'failed', error: 'still assigned after the request' });
        if (blocked.length) actions.push({ action: 'remove_roles', targetId: actorId, roleIds: blocked.map((r) => String(r.id)), result: 'skipped', error: 'above ZiGBoT or managed' });
        if (removed.length === 0) return result('failed', 'Discord still shows the roles on the actor', actions);
        const partial = still.length > 0 || blocked.length > 0;
        return result(partial ? 'partial' : 'succeeded', `removed ${removed.length} dangerous role(s) from <@${actorId}>${partial ? `; ${still.length + blocked.length} could not be removed` : ''}`, actions);
    } catch (error) {
        return result('failed', `Discord refused to remove the roles (${errorCode(error)})`, [{ action: 'remove_roles', targetId: actorId, roleIds, result: 'failed', error: errorCode(error) }]);
    }
}

async function kickBot({ guild, me, incident }) {
    const botId = incident.botId;
    if (!botId) return result('skipped', 'the added bot could not be identified');
    if (!me.permissions.has(PermissionFlagsBits.KickMembers)) return result('skipped', 'ZiGBoT lacks the Kick Members permission');
    const member = await fetchMember(guild, botId);
    if (!member) return result('skipped', 'the bot is no longer in the server');
    if (!member.user?.bot) return result('skipped', 'the target is not a bot');
    if (!member.kickable) return result('skipped', 'the bot\'s role sits above ZiGBoT\'s highest role', [{ action: 'kick_bot', targetId: botId, result: 'skipped' }]);
    try {
        await member.kick(REASON);
    } catch (error) {
        return result('failed', `Discord refused the kick (${errorCode(error)})`, [{ action: 'kick_bot', targetId: botId, result: 'failed', error: errorCode(error) }]);
    }
    const stillThere = await fetchMember(guild, botId);
    if (stillThere) return result('failed', 'the bot is still in the server after the kick request', [{ action: 'kick_bot', targetId: botId, result: 'failed', error: 'still present' }]);
    return result('succeeded', `kicked the bot <@${botId}> (re-invite it if it was wanted)`, [{ action: 'kick_bot', targetId: botId, result: 'ok' }]);
}

/**
 * Decide and run containment for one incident. Returns
 * { status: not_enabled | not_applicable | skipped | succeeded | partial | failed, summary, actions }.
 */
async function runContainment({ incident, guild, settings }) {
    const me = guild?.members?.me;
    const wantsStrip = STRIP_RULES.has(incident.rule) && incident.severity === 'CRITICAL';
    const wantsKick = BOT_RULES.has(incident.rule);
    if (!wantsStrip && !wantsKick) return result('not_applicable', '');
    if (wantsStrip && !settings.containment.strip_dangerous_roles) return result('not_enabled', '');
    if (wantsKick && !settings.containment.remove_unauthorized_bots) return result('not_enabled', '');
    if (!me) return result('skipped', 'ZiGBoT could not read its own permissions');
    const target = wantsKick ? incident.botId : incident.actorId;
    if (!target) return result('skipped', 'the responsible account could not be identified');
    if (String(target) === String(guild.ownerId)) return result('skipped', 'the server owner is never moderated automatically');
    if (String(target) === String(me.id)) return result('skipped', 'ZiGBoT never acts on itself');
    try {
        return wantsKick ? await kickBot({ guild, me, incident }) : await stripRoles({ guild, me, incident });
    } catch (error) {
        return result('failed', `unexpected error (${errorCode(error)})`);
    }
}

module.exports = { runContainment, STRIP_RULES, BOT_RULES };
