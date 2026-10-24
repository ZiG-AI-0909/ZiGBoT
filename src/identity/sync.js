/**
 * Custom bot identity sync (bot worker). Keeps ZiGBoT's own profile in each
 * server in line with what was saved and paid for:
 *  - Premium, not blocked: the saved nickname/bio and the APPROVED avatar.
 *  - Premium lapsed or server blocked: the default ZiGBoT profile (revert).
 *  - No saved identity: the server is never touched (admins may have
 *    nicknamed the bot themselves).
 *  - Not one of CUSTOM_IDENTITY_GUILDS (when that list is set): default.
 * Runs on startup, when the bot joins a server, and every 10 minutes. Only
 * changed fields are sent (Discord does not publish this route's rate limit;
 * discord.js waits out any 429). Deletes the stored identity when the bot is
 * removed from a server, and 30 days after a server's Premium lapsed or it
 * was blocked.
 *
 * With CUSTOM_IDENTITY_ENABLED off the sync is REVERT-ONLY: every applied
 * identity is put back to the default ZiGBoT profile and nothing else
 * happens (nothing applied, nothing deleted). Without the Supabase config
 * store it does nothing at all.
 */
const {
    IDENTITY_LIMITS,
    DEFAULT_IDENTITY,
    identityAllowedInGuild,
    identityImagePath,
    identityDesired,
    identityApplied,
    identityPatch,
    isDefaultIdentity,
    identityAuditReason
} = require('../../dashboard/lib/shared');

const DAY_MS = 24 * 60 * 60 * 1000;
const SYNC_INTERVAL_MS = 10 * 60 * 1000;

const auditView = (row) => (row ? {
    nick: row.nick, bio: row.bio, avatar_sha256: row.avatar_sha256, pending_avatar_sha256: row.pending_avatar_sha256,
    applied_nick: row.applied_nick, applied_bio: row.applied_bio, applied_avatar_sha256: row.applied_avatar_sha256,
    reverted_at: row.reverted_at, revert_reason: row.revert_reason
} : null);

function createIdentitySync({ client, store, getContext, enabled, guilds = [], logger = console, now = () => Date.now(), intervalMs = SYNC_INTERVAL_MS }) {
    const mode = !store?.enabled ? 'off' : enabled ? 'full' : 'revert-only';
    const active = mode !== 'off';
    const revertOnly = mode === 'revert-only';
    const running = new Set();
    const log = (message) => logger.log?.(`[ZiGBoT IDENTITY] ${message}`);
    const fail = (guildId, step, error) => logger.error?.(`[ZiGBoT IDENTITY] ${step} failed for ${guildId}: ${error?.code || error?.status || error?.message || 'Error'}`);

    async function deleteIdentity(guildId, row, reason) {
        await store.removeAvatars([row.avatar_path, row.pending_avatar_path]);
        await store.deleteRow(guildId);
        await store.audit({ guildId, action: 'DELETE', before: auditView(row), after: { reason } });
        log(`Deleted the stored identity for ${guildId} (${reason}).`);
    }

    /** Bring one server's bot profile in line. Returns what happened (for logs/tests). */
    async function reconcile(guild, { row: knownRow } = {}) {
        if (!active || !guild?.id) return 'off';
        const guildId = String(guild.id);
        if (running.has(guildId)) return 'busy';
        running.add(guildId);
        try {
            const row = knownRow === undefined ? await store.getRow(guildId) : knownRow;
            if (!row) return 'none';
            let premium = false;
            let blocked = false;
            if (!revertOnly) {
                const [ctx, isBlocked] = await Promise.all([getContext(guild), store.isGuildBlocked(guildId)]);
                premium = Boolean(ctx?.premium);
                blocked = isBlocked;
            }
            const allowed = !revertOnly && identityAllowedInGuild(guildId, guilds);
            let applied = identityApplied(row);

            // Premium lapsed / blocked for 30 days (and nothing left on Discord): delete it.
            if (!revertOnly && (!premium || blocked)) {
                const since = Date.parse(row.reverted_at || (isDefaultIdentity(applied) ? row.updated_at : '') || '');
                if (Number.isFinite(since) && now() - since > IDENTITY_LIMITS.lapsedImageDays * DAY_MS && isDefaultIdentity(applied)) {
                    await deleteIdentity(guildId, row, blocked ? 'blocked_cleanup' : 'lapsed_cleanup');
                    return 'deleted';
                }
            }

            // Re-added since our last change: Discord shows the default profile again.
            const joinedAt = guild.members?.me?.joinedTimestamp;
            const appliedAt = Date.parse(row.applied_at || '');
            if (!isDefaultIdentity(applied) && Number.isFinite(joinedAt) && Number.isFinite(appliedAt) && joinedAt > appliedAt) {
                applied = DEFAULT_IDENTITY;
                await store.updateRow(guildId, { applied_nick: null, applied_bio: null, applied_avatar_sha256: null, applied_at: new Date(now()).toISOString() });
            }

            const desired = revertOnly ? DEFAULT_IDENTITY : identityDesired({ row, premium, blocked, allowed });
            const patch = identityPatch(desired, applied);
            if (Object.keys(patch).length === 0) return 'ok';

            const reverting = isDefaultIdentity(desired);
            const revertReason = revertOnly ? 'feature_disabled'
                : blocked ? 'blocked'
                    : !allowed ? 'not_enabled_here'
                        : premium ? null : 'premium_lapsed';
            const options = { reason: identityAuditReason(reverting && revertReason ? `revert: ${revertReason}` : 'sync') };
            if ('nick' in patch) options.nick = patch.nick;
            if ('bio' in patch) options.bio = patch.bio;
            if ('avatarSha' in patch) options.avatar = patch.avatarSha ? await store.downloadAvatar(identityImagePath(guildId, patch.avatarSha)) : null;
            await guild.members.editMe(options);

            const nowIso = new Date(now()).toISOString();
            const fields = {
                applied_nick: desired.nick,
                applied_bio: desired.bio,
                applied_avatar_sha256: desired.avatarSha,
                applied_at: nowIso,
                reverted_at: reverting && revertReason ? nowIso : null,
                revert_reason: reverting && revertReason ? revertReason : null
            };
            await store.updateRow(guildId, fields);
            await store.audit({ guildId, action: reverting ? 'REVERT' : 'APPLY', before: auditView(row), after: { ...auditView(row), ...fields } });
            log(`${reverting ? 'Reverted' : 'Applied'} the custom identity in ${guildId}${revertReason ? ` (${revertReason})` : ''}.`);
            return reverting ? 'reverted' : 'applied';
        } catch (error) {
            fail(guildId, 'Sync', error);
            return 'error';
        } finally {
            running.delete(guildId);
        }
    }

    async function sweep() {
        if (!active) return;
        let rows;
        try {
            rows = await store.listRows();
        } catch (error) {
            fail('all servers', 'Listing identities', error);
            return;
        }
        for (const row of rows) {
            const guildId = String(row.guild_id);
            const guild = client.guilds.cache.get(guildId);
            if (guild) {
                await reconcile(guild, { row });
            } else if (!revertOnly && client.isReady?.()) {
                // Removed while the bot was offline: nothing of it stays stored.
                await deleteIdentity(guildId, row, 'bot_removed').catch((error) => fail(guildId, 'Cleanup', error));
            }
        }
    }

    function start() {
        if (!active) return null;
        sweep();
        const timer = setInterval(sweep, intervalMs);
        timer.unref?.();
        return timer;
    }

    async function onGuildRemoved(guildId) {
        if (mode !== 'full') return;
        try {
            const row = await store.getRow(guildId);
            if (row) await deleteIdentity(String(guildId), row, 'bot_removed');
        } catch (error) {
            fail(guildId, 'Cleanup', error);
        }
    }

    return { mode, active, reconcile, sweep, start, onGuildRemoved };
}

module.exports = { createIdentitySync, SYNC_INTERVAL_MS };
