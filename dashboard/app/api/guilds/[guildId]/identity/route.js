import shared from '@/lib/shared';
import { handler, json, HttpError } from '@/lib/http';
import { requireGuildAdmin } from '@/lib/auth';
import { loadPlan } from '@/lib/billing';
import { processAvatar, IdentityImageError } from '@/lib/identityImage';
import {
    getIdentityRow, saveIdentityRow, getBlocks, countRecentSaves, uploadAvatar, removeAvatars,
    pushIdentity, resetIdentity, writeAudit, auditView, notifyOwnerOfPending, identityDiscordError, identityEnabledFor
} from '@/lib/identity';

const { IDENTITY_LIMITS, validateIdentityName, validateIdentityBio, decideIdentitySave, identityImagePath } = shared;

export const dynamic = 'force-dynamic';

// The multipart body: a 2 MB picture plus two short text fields.
const MAX_BODY_BYTES = IDENTITY_LIMITS.imageMaxBytes + 64 * 1024;

function view(row, { premium, blocks }) {
    return {
        enabled: true,
        premium,
        blocked: blocks.guildBlocked || blocks.userBlocked,
        limits: IDENTITY_LIMITS,
        identity: row ? {
            nick: row.nick || '',
            bio: row.bio || '',
            hasAvatar: Boolean(row.avatar_path),
            hasPending: Boolean(row.pending_avatar_path),
            pendingSubmittedAt: row.pending_submitted_at,
            reviewNote: row.review_note,
            appliedAt: row.applied_at,
            revertedAt: row.reverted_at,
            revertReason: row.revert_reason,
            live: { nick: row.applied_nick, bio: row.applied_bio, hasAvatar: Boolean(row.applied_avatar_sha256) }
        } : null
    };
}

// GET: this server's identity (admins only; reports enabled: false when the
// feature is off, or this server is not in CUSTOM_IDENTITY_GUILDS).
export const GET = handler(async (_request, { params }) => {
    const { guildId } = await params;
    const { guild, discordId } = await requireGuildAdmin(guildId);
    if (!identityEnabledFor(guild.id)) return json({ enabled: false });
    const [row, plan, blocks] = await Promise.all([getIdentityRow(guild.id), loadPlan(guild), getBlocks({ guildId: guild.id, discordUserId: discordId })]);
    return json(view(row, { premium: plan.premium, blocks }));
});

// PUT (multipart): nick, bio, optional avatar file, optional remove_avatar=1.
// Nickname and bio go live straight away (Discord checks them too, so a name
// Discord refuses is never saved). A new avatar waits for the owner's review.
export const PUT = handler(async (request, { params }) => {
    const { guildId } = await params;
    if (!identityEnabledFor(guildId)) throw new HttpError(404, 'Custom bot identity isn’t available in this server yet.', { code: 'identity_disabled' });
    const access = await requireGuildAdmin(guildId);
    const { guild, discordId, user } = access;

    if (Number(request.headers.get('content-length') || 0) > MAX_BODY_BYTES) throw new HttpError(413, 'That upload is too large.');
    let form;
    try {
        form = await request.formData();
    } catch {
        throw new HttpError(400, 'Please send the identity as a form.');
    }
    const nick = validateIdentityName(form.get('nick') ?? '');
    const bio = validateIdentityBio(form.get('bio') ?? '');
    const fieldErrors = {};
    if (nick.error) fieldErrors.nick = nick.error;
    if (bio.error) fieldErrors.bio = bio.error;
    if (Object.keys(fieldErrors).length) throw new HttpError(422, 'Some fields need fixing.', { fieldErrors });

    const [row, plan, blocks, recent] = await Promise.all([
        getIdentityRow(guild.id), loadPlan(guild), getBlocks({ guildId: guild.id, discordUserId: discordId }), countRecentSaves(guild.id)
    ]);
    const decision = decideIdentitySave({
        enabled: true, premium: plan.premium, guildBlocked: blocks.guildBlocked, userBlocked: blocks.userBlocked,
        changesLastHour: recent.hour, changesLastDay: recent.day
    });
    if (!decision.allowed) throw new HttpError(decision.status, decision.reason, { code: decision.code });

    const file = form.get('avatar');
    const removeAvatar = form.get('remove_avatar') === '1';
    let processed = null;
    if (file && typeof file === 'object' && file.size > 0) {
        if (file.size > IDENTITY_LIMITS.imageMaxBytes) throw new HttpError(413, `Pictures can be at most ${IDENTITY_LIMITS.imageMaxBytes / (1024 * 1024)} MB.`);
        try {
            processed = await processAvatar(Buffer.from(await file.arrayBuffer()));
        } catch (error) {
            if (error instanceof IdentityImageError) throw new HttpError(422, error.message, { fieldErrors: { avatar: error.message } });
            throw error;
        }
    }

    const nowIso = new Date().toISOString();
    const next = {
        ...(row || {}),
        guild_id: String(guild.id),
        nick: nick.value,
        bio: bio.value,
        updated_by: user.id,
        updated_by_discord_id: discordId,
        updated_at: nowIso
    };
    const stale = [];
    if (removeAvatar) {
        stale.push(row?.avatar_path, row?.pending_avatar_path);
        Object.assign(next, { avatar_path: null, avatar_sha256: null, pending_avatar_path: null, pending_avatar_sha256: null, pending_submitted_at: null, pending_submitted_by: null });
    }
    let uploadedPath = null;
    if (processed) {
        const path = identityImagePath(guild.id, processed.sha256);
        if (path !== row?.avatar_path) {
            uploadedPath = path !== row?.pending_avatar_path ? await uploadAvatar(guild.id, processed.png, processed.sha256) : path;
            if (row?.pending_avatar_path && row.pending_avatar_path !== path) stale.push(row.pending_avatar_path);
            Object.assign(next, { pending_avatar_path: path, pending_avatar_sha256: processed.sha256, pending_submitted_at: nowIso, pending_submitted_by: discordId, review_note: null });
        }
    }

    let applied = null;
    try {
        applied = await pushIdentity(guild.id, next, { premium: true, blocked: false, reason: `updated by ${discordId}` });
    } catch (error) {
        if (uploadedPath && uploadedPath !== row?.pending_avatar_path) await removeAvatars([uploadedPath]);
        throw identityDiscordError(error);
    }
    const saved = await saveIdentityRow({ ...next, ...(applied || {}) });
    await removeAvatars(stale.filter((path) => path && path !== saved.avatar_path && path !== saved.pending_avatar_path));
    await writeAudit({ guildId: guild.id, action: row ? 'UPDATE' : 'INSERT', actorUserId: user.id, actorRole: 'authenticated', before: auditView(row), after: auditView(saved) });
    if (uploadedPath && uploadedPath !== row?.pending_avatar_path) await notifyOwnerOfPending(guild);
    return json(view(saved, { premium: plan.premium, blocks }));
});

// DELETE: back to the default ZiGBoT profile; the saved identity and its
// pictures are deleted. Always allowed for admins (even if the feature or
// the server's Premium is off), so nobody is ever stuck with an identity.
export const DELETE = handler(async (_request, { params }) => {
    const { guildId } = await params;
    const { guild, discordId, user } = await requireGuildAdmin(guildId);
    const result = await resetIdentity(guild.id, { actorUserId: user.id, actorRole: 'authenticated', discordUserId: discordId });
    if (result.discordError) {
        console.error('[identity] reset: Discord update failed:', result.discordError?.status || result.discordError?.message);
        return json({ reset: true, warning: 'Your saved identity was deleted, but Discord didn’t accept the profile reset. Run /identity reset in Discord to try again.' });
    }
    return json({ reset: true });
});
