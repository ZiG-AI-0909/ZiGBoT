import 'server-only';
import { cache } from 'react';
import shared from './shared';
import { createUserClient, createServiceClient } from './supabase/server';
import { getGuild, getMember } from './discord';
import { HttpError } from './http';

const { discordIdFromUser, decideGuildAccess, SNOWFLAKE } = shared;

/**
 * The logged-in user, validated by Supabase Auth (getUser() checks the JWT server-side).
 * Memoized per request with React cache(), so a page that calls it and then
 * requireGuildAdmin() makes one auth round trip, not two.
 */
export const getCurrentUser = cache(async () => {
    const supabase = await createUserClient();
    const { data, error } = await supabase.auth.getUser();
    if (error || !data?.user) return null;
    return { user: data.user, discordId: discordIdFromUser(data.user), supabase };
});

export async function requireUser() {
    const current = await getCurrentUser();
    if (!current) throw new HttpError(401, 'Please sign in.');
    if (!current.discordId) throw new HttpError(401, 'Your login has no verified Discord identity. Sign in with Discord again.');
    return current;
}

/**
 * LIVE verification that the current user may manage `guildId`:
 *   Supabase session -> Discord identity -> bot-token fetch of the guild and
 *   the member -> computed permissions (owner / Administrator / Manage Server).
 * Runs on every privileged request. On success it refreshes the short-lived
 * zb_guild_admins row that the RLS policies require; on failure it deletes it.
 *
 * `onVerified(guild)` (optional) starts extra bot-token reads the moment
 * access is granted, so they overlap the two verification writes below. Its
 * promise is returned as `early`; nothing from it reaches the caller unless
 * the decision allowed access.
 */
export async function requireGuildAdmin(guildId, { onVerified = null } = {}) {
    const current = await requireUser();
    if (!SNOWFLAKE.test(String(guildId || ''))) throw new HttpError(400, 'Invalid server id.');

    // Guild and member are independent reads: fetch them together. A member
    // lookup for a server the bot is not in just returns null.
    const [guild, fetchedMember] = await Promise.all([
        getGuild(guildId),
        getMember(guildId, current.discordId)
    ]);
    const member = guild ? fetchedMember : null;
    const decision = decideGuildAccess({ guild, member, discordUserId: current.discordId });
    const service = createServiceClient();

    if (!decision.allowed) {
        await service.from('zb_guild_admins').delete().match({ user_id: current.user.id, guild_id: String(guildId) });
        throw new HttpError(decision.status, decision.reason, { code: decision.code });
    }

    const early = onVerified ? onVerified(guild) : null;
    // If a write below throws, the early reads must not surface as an unhandled rejection.
    early?.catch(() => {});

    const nowIso = new Date().toISOString();
    const { error: guildError } = await service.from('zb_guilds').upsert({
        guild_id: String(guild.id),
        name: String(guild.name || '').slice(0, 100),
        icon: guild.icon || null,
        owner_discord_id: String(guild.owner_id),
        bot_installed: true,
        removed_at: null,
        updated_at: nowIso
    }, { onConflict: 'guild_id' });
    if (guildError) throw new Error(`zb_guilds upsert failed: ${guildError.message}`);

    const { error: adminError } = await service.from('zb_guild_admins').upsert({
        user_id: current.user.id,
        guild_id: String(guild.id),
        discord_user_id: current.discordId,
        verified_at: nowIso
    }, { onConflict: 'user_id,guild_id' });
    if (adminError) throw new Error(`zb_guild_admins upsert failed: ${adminError.message}`);

    return { ...current, guild, member, decision, early };
}
