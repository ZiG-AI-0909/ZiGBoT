import 'server-only';
import { getCurrentUser } from './auth';
import { createServiceClient } from './supabase/server';
import { HttpError } from './http';
import { env } from './env';

/**
 * Super Admin access (/admin and /api/admin/*).
 *
 * Who: only Discord accounts listed in SUPER_ADMIN_DISCORD_IDS (server-side
 * env; falls back to BOT_CREATOR_ID). Nothing in the database, the browser
 * or any API can add an admin. With no valid ID configured, nobody gets in.
 *
 * How: the Supabase session (Discord OAuth) is verified server-side on every
 * request (getUser() checks the JWT with Supabase), its Discord identity is
 * compared with the list, and anyone else gets a 404, as if /admin did not
 * exist. Pages and API routes each call this themselves; nothing relies on
 * hidden links or browser checks.
 */

export function isSuperAdmin(discordId) {
    const ids = env.superAdminDiscordIds;
    return ids.length > 0 && ids.includes(String(discordId || ''));
}

/** For pages: the admin, or null (the page calls notFound()). */
export async function getSuperAdmin() {
    const current = await getCurrentUser().catch(() => null);
    if (!current || !isSuperAdmin(current.discordId)) return null;
    return current;
}

/** For API routes: the admin, or a 404 HttpError. */
export async function requireSuperAdmin() {
    const admin = await getSuperAdmin();
    if (!admin) throw new HttpError(404, 'Not found.');
    return admin;
}

// Per-admin rate limit for state-changing admin requests (per server
// instance; Vercel may run several, so this is a brake, not a quota).
const hits = new Map();
export function adminRateLimit(discordId, { max = 60, windowMs = 60_000 } = {}) {
    const now = Date.now();
    const recent = (hits.get(discordId) || []).filter((t) => now - t < windowMs);
    if (recent.length >= max) throw new HttpError(429, 'Too many admin actions in a minute. Wait a moment.');
    recent.push(now);
    hits.set(discordId, recent);
}

/**
 * Append to the admin audit log (insert-only: a database trigger refuses
 * updates and deletes, even for the service role). Never stores secrets;
 * metadata should be small and non-sensitive.
 */
export async function writeAdminAudit(admin, { action, targetType = null, targetId = null, outcome = 'ok', metadata = {} }) {
    const { error } = await createServiceClient().from('zb_admin_audit_log').insert({
        admin_user_id: admin.user.id,
        admin_discord_id: admin.discordId,
        action: String(action).slice(0, 60),
        target_type: targetType ? String(targetType).slice(0, 40) : null,
        target_id: targetId ? String(targetId).slice(0, 100) : null,
        outcome: String(outcome).slice(0, 20),
        metadata
    });
    if (error) console.error('[admin] audit write failed:', error.message);
}
