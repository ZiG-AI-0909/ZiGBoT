import 'server-only';
import shared from './shared';
import { createServiceClient } from './supabase/server';
import { env } from './env';
import { getGuild, modifyCurrentMember, sendDirectMessage } from './discord';
import { loadPlan } from './billing';
import { HttpError } from './http';

/**
 * Custom bot identity, server side: storage, Discord updates, blocks and
 * audit. Callers verify access first (requireGuildAdmin / the owner check);
 * everything here uses the service role. Image bytes are never written to
 * the audit log, only their SHA-256.
 */
const { IDENTITY_BUCKET, identityImagePath, identityDesired, identityApplied, identityPatch, isDefaultIdentity, identityAuditReason, SNOWFLAKE } = shared;

const TABLE = 'zb_guild_identity';
const db = () => createServiceClient();

export async function getIdentityRow(guildId) {
    const { data, error } = await db().from(TABLE).select('*').eq('guild_id', String(guildId)).maybeSingle();
    if (error) throw new Error(`Identity read failed: ${error.message}`);
    return data || null;
}

export async function saveIdentityRow(row) {
    const { data, error } = await db().from(TABLE).upsert(row, { onConflict: 'guild_id' }).select('*').maybeSingle();
    if (error) throw new Error(`Identity save failed: ${error.message}`);
    return data;
}

export async function deleteIdentityRow(guildId) {
    const { error } = await db().from(TABLE).delete().eq('guild_id', String(guildId));
    if (error) throw new Error(`Identity delete failed: ${error.message}`);
}

export async function getBlocks({ guildId, discordUserId }) {
    const targets = [guildId, discordUserId].filter((id) => SNOWFLAKE.test(String(id || ''))).map(String);
    if (targets.length === 0) return { guildBlocked: false, userBlocked: false };
    const { data, error } = await db().from('zb_identity_blocks').select('kind, target_id').in('target_id', targets);
    if (error) throw new Error(`Block lookup failed: ${error.message}`);
    const has = (kind, id) => (data || []).some((b) => b.kind === kind && b.target_id === String(id));
    return { guildBlocked: has('guild', guildId), userBlocked: Boolean(discordUserId) && has('user', discordUserId) };
}

/** Admin saves in the last hour / day (the cooldown counts saves, never resets). */
export async function countRecentSaves(guildId, now = Date.now()) {
    const since = async (ms) => {
        const { count, error } = await db().from('zb_config_audit_log').select('id', { count: 'exact', head: true })
            .eq('guild_id', String(guildId)).eq('table_name', TABLE).in('action', ['INSERT', 'UPDATE'])
            .gte('created_at', new Date(now - ms).toISOString());
        if (error) throw new Error(`Cooldown lookup failed: ${error.message}`);
        return count || 0;
    };
    const [hour, day] = await Promise.all([since(60 * 60 * 1000), since(24 * 60 * 60 * 1000)]);
    return { hour, day };
}

/** The fields of a row that are safe and useful in the audit log. */
export function auditView(row) {
    if (!row) return null;
    const { nick, bio, avatar_sha256, pending_avatar_sha256, review_note, applied_nick, applied_bio, applied_avatar_sha256, reverted_at, revert_reason } = row;
    return { nick, bio, avatar_sha256, pending_avatar_sha256, review_note, applied_nick, applied_bio, applied_avatar_sha256, reverted_at, revert_reason };
}

export async function writeAudit({ guildId, action, actorUserId = null, actorRole = 'service_role', before = null, after = null }) {
    const { error } = await db().from('zb_config_audit_log').insert({
        guild_id: String(guildId),
        actor_user_id: actorUserId,
        actor_role: actorRole,
        action,
        table_name: TABLE,
        record_key: String(guildId),
        before,
        after
    });
    if (error) console.error('[identity] audit write failed:', error.message);
}

export async function uploadAvatar(guildId, png, sha256) {
    const path = identityImagePath(guildId, sha256);
    const { error } = await db().storage.from(IDENTITY_BUCKET).upload(path, png, { contentType: 'image/png', upsert: true });
    if (error) throw new Error(`Avatar upload failed: ${error.message}`);
    return path;
}

export async function downloadAvatar(path) {
    const { data, error } = await db().storage.from(IDENTITY_BUCKET).download(path);
    if (error || !data) throw new Error(`Avatar download failed: ${error?.message || 'missing'}`);
    return Buffer.from(await data.arrayBuffer());
}

/** Delete stored avatars; failures are logged (a stray file is harmless, a crash is not). */
export async function removeAvatars(paths) {
    const list = [...new Set((paths || []).filter(Boolean))];
    if (list.length === 0) return;
    const { error } = await db().storage.from(IDENTITY_BUCKET).remove(list);
    if (error) console.error('[identity] avatar delete failed:', error.message);
}

/** A Discord error as something the admin can act on. */
export function identityDiscordError(error) {
    if (error?.status === 403 || error?.code === 50013) {
        return new HttpError(403, 'ZiGBoT needs the “Change Nickname” permission in this server to use a custom name. Give it that permission and try again.', { code: 'missing_permission' });
    }
    if (error?.status === 400) return new HttpError(400, `Discord refused that: ${error.discordMessage || 'invalid value'}.`, { code: 'discord_rejected' });
    if (error?.status === 429) return new HttpError(429, 'Discord is rate limiting profile changes right now. Please try again in a few minutes.', { code: 'discord_rate_limited' });
    return error;
}

/**
 * Bring the bot's Discord profile in this server in line with `row` (the
 * desired state is decided by lib/shared/identity.js). Sends only changed
 * fields. Returns the applied_* columns to store, or null when nothing was
 * sent. Throws Discord errors to the caller.
 */
export async function pushIdentity(guildId, row, { premium, blocked, reason, revertReason = null, now = Date.now() }) {
    const desired = identityDesired({ row, premium, blocked });
    const patch = identityPatch(desired, identityApplied(row));
    if (Object.keys(patch).length === 0) return null;
    const fields = {};
    if ('nick' in patch) fields.nick = patch.nick;
    if ('bio' in patch) fields.bio = patch.bio;
    if ('avatarSha' in patch) {
        fields.avatar = patch.avatarSha
            ? `data:image/png;base64,${(await downloadAvatar(identityImagePath(guildId, patch.avatarSha))).toString('base64')}`
            : null;
    }
    await modifyCurrentMember(guildId, fields, identityAuditReason(reason));
    const reverting = isDefaultIdentity(desired) && Boolean(revertReason);
    return {
        applied_nick: desired.nick,
        applied_bio: desired.bio,
        applied_avatar_sha256: desired.avatarSha,
        applied_at: new Date(now).toISOString(),
        reverted_at: reverting ? new Date(now).toISOString() : null,
        revert_reason: reverting ? revertReason : null
    };
}

/** Is this server Premium right now (home servers included)? */
export async function guildPremium(guildId) {
    const guild = await getGuild(guildId);
    if (!guild) return { guild: null, premium: false };
    const plan = await loadPlan(guild);
    return { guild, premium: plan.premium };
}

/** Put the default ZiGBoT profile back (Premium lapsed, or blocked). Keeps the saved row. */
export async function revertIdentity(guildId, revertReason) {
    const row = await getIdentityRow(guildId);
    if (!row) return false;
    const applied = await pushIdentity(guildId, row, { premium: false, blocked: true, reason: revertReason, revertReason });
    if (!applied) return false;
    const next = await saveIdentityRow({ ...row, ...applied, updated_at: new Date().toISOString() });
    await writeAudit({ guildId, action: 'REVERT', before: auditView(row), after: auditView(next) });
    return true;
}

/**
 * Reset to the default ZiGBoT profile and delete everything stored for this
 * server's identity. Discord is reset even if our row is already gone.
 */
export async function resetIdentity(guildId, { actorUserId = null, actorRole = 'service_role', discordUserId = null } = {}) {
    const row = await getIdentityRow(guildId);
    let discordError = null;
    try {
        await modifyCurrentMember(guildId, { nick: null, bio: null, avatar: null }, identityAuditReason('reset to default', discordUserId ? `by ${discordUserId}` : ''));
    } catch (error) {
        discordError = error;
    }
    if (row) {
        await removeAvatars([row.avatar_path, row.pending_avatar_path]);
        await deleteIdentityRow(guildId);
        await writeAudit({ guildId, action: 'RESET', actorUserId, actorRole, before: auditView(row), after: discordUserId ? { by_discord_id: discordUserId } : null });
    }
    return { hadIdentity: Boolean(row), discordError };
}

const plainName = (name) => String(name || 'a server').replace(/[*_~`|>\\]/g, '').slice(0, 80);

/** Tell the bot owner an avatar is waiting for review (never fails the caller). */
export async function notifyOwnerOfPending(guild) {
    const ownerId = env.botCreatorId;
    if (!SNOWFLAKE.test(String(ownerId || ''))) return;
    const link = env.siteUrl ? `\nReview it: ${env.siteUrl}/owner/identity` : '';
    try {
        await sendDirectMessage(ownerId, `🪪 A new ZiGBoT avatar is waiting for review in ${plainName(guild?.name)} (${guild?.id}).${link}`);
    } catch (error) {
        console.error('[identity] owner DM failed:', error?.status || error?.message);
    }
}

/** True when the signed-in Discord user is the bot owner (BOT_CREATOR_ID). */
export function isBotOwner(discordId) {
    return SNOWFLAKE.test(String(env.botCreatorId || '')) && String(discordId || '') === env.botCreatorId;
}
