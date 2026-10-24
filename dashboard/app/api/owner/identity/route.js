import shared from '@/lib/shared';
import { handler, json, readJson, HttpError } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import { createServiceClient } from '@/lib/supabase/server';
import {
    getIdentityRow, saveIdentityRow, getBlocks, removeAvatars, pushIdentity, revertIdentity,
    writeAudit, auditView, guildPremium, isBotOwner, identityEnabledFor
} from '@/lib/identity';

const { SNOWFLAKE } = shared;

export const dynamic = 'force-dynamic';

const ACTIONS = new Set(['approve', 'reject', 'block', 'unblock']);
const clean = (text, max = 300) => String(text || '').replace(/\s+/g, ' ').trim().slice(0, max) || null;

// POST { action, guildId, note?, kind?, targetId?, reason? } — bot owner only
// (BOT_CREATOR_ID). Everyone else gets a 404, as if the route did not exist.
export const POST = handler(async (request) => {
    const current = await requireUser();
    if (!isBotOwner(current.discordId)) throw new HttpError(404, 'Not found.');
    const body = await readJson(request);
    const action = String(body?.action || '');
    const guildId = String(body?.guildId || '');
    if (!ACTIONS.has(action) || !SNOWFLAKE.test(guildId)) throw new HttpError(400, 'Unknown action or server.');
    const actor = { actorUserId: current.user.id, actorRole: 'bot_owner' };

    if (action === 'approve' || action === 'reject') {
        const row = await getIdentityRow(guildId);
        if (!row?.pending_avatar_path) throw new HttpError(409, 'There is no picture waiting for review in that server.');
        const nowIso = new Date().toISOString();
        const cleared = { pending_avatar_path: null, pending_avatar_sha256: null, pending_submitted_at: null, pending_submitted_by: null, updated_at: nowIso };
        if (action === 'reject') {
            const saved = await saveIdentityRow({ ...row, ...cleared, review_note: clean(body.note) || 'This picture wasn’t approved. Please choose another one.' });
            await removeAvatars([row.pending_avatar_path]);
            await writeAudit({ guildId, action: 'REVIEW', ...actor, before: auditView(row), after: { ...auditView(saved), decision: 'rejected' } });
            return json({ ok: true });
        }
        let next = { ...row, ...cleared, avatar_path: row.pending_avatar_path, avatar_sha256: row.pending_avatar_sha256, review_note: null };
        let warning = null;
        if (identityEnabledFor(guildId)) {
            // Apply now if the server qualifies; otherwise the bot's sync applies it later.
            try {
                const [{ guild, premium }, blocks] = await Promise.all([guildPremium(guildId), getBlocks({ guildId })]);
                if (guild) {
                    const applied = await pushIdentity(guildId, next, { premium, blocked: blocks.guildBlocked, reason: 'avatar approved', revertReason: premium ? null : 'premium_inactive' });
                    if (applied) next = { ...next, ...applied };
                }
            } catch (error) {
                warning = 'Approved, but Discord didn’t accept the picture yet. The bot will retry on its next sync.';
                console.error('[identity] approve: Discord update failed:', error?.status || error?.message);
            }
        }
        const saved = await saveIdentityRow(next);
        if (row.avatar_path && row.avatar_path !== saved.avatar_path) await removeAvatars([row.avatar_path]);
        await writeAudit({ guildId, action: 'REVIEW', ...actor, before: auditView(row), after: { ...auditView(saved), decision: 'approved' } });
        return json({ ok: true, warning });
    }

    // Blocks: a whole server, or one Discord user (recorded against the server it came from).
    const kind = body?.kind === 'user' ? 'user' : 'guild';
    const targetId = kind === 'guild' ? guildId : String(body?.targetId || '');
    if (!SNOWFLAKE.test(targetId)) throw new HttpError(400, 'Invalid user id.');
    const db = createServiceClient();
    if (action === 'block') {
        const { error } = await db.from('zb_identity_blocks').upsert(
            { kind, target_id: targetId, reason: clean(body.reason), context_guild_id: guildId, created_by_discord_id: current.discordId },
            { onConflict: 'kind,target_id' }
        );
        if (error) throw new Error(`Block failed: ${error.message}`);
        let warning = null;
        if (kind === 'guild') {
            try {
                await revertIdentity(guildId, 'blocked');
            } catch (error) {
                warning = 'Blocked, but Discord didn’t accept the profile reset yet. The bot will retry on its next sync.';
                console.error('[identity] block: revert failed:', error?.status || error?.message);
            }
        }
        await writeAudit({ guildId, action: 'BLOCK', ...actor, after: { kind, target_id: targetId, reason: clean(body.reason), blocked: true } });
        return json({ ok: true, warning });
    }
    const { error } = await db.from('zb_identity_blocks').delete().match({ kind, target_id: targetId });
    if (error) throw new Error(`Unblock failed: ${error.message}`);
    await writeAudit({ guildId, action: 'BLOCK', ...actor, after: { kind, target_id: targetId, blocked: false } });
    return json({ ok: true });
});
