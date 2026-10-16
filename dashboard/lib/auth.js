import 'server-only';
import shared from './shared';
import { createUserClient, createServiceClient } from './supabase/server';
import { getGuild, getMember } from './discord';
import { HttpError } from './http';

const { discordIdFromUser, decideGuildAccess, SNOWFLAKE } = shared;

/** The logged-in user, validated by Supabase Auth (getUser() checks the JWT server-side). */
export async function getCurrentUser() {
    const supabase = await createUserClient();
    const { data, error } = await supabase.auth.getUser();
    if (error || !data?.user) return null;
    return { user: data.user, discordId: discordIdFromUser(data.user), supabase };
}

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
 */
export async function requireGuildAdmin(guildId) {
    const current = await requireUser();
    if (!SNOWFLAKE.test(String(guildId || ''))) throw new HttpError(400, 'Invalid server id.');

    const guild = await getGuild(guildId);
    const member = guild ? await getMember(guildId, current.discordId) : null;
    const decision = decideGuildAccess({ guild, member, discordUserId: current.discordId });
    const service = createServiceClient();

    if (!decision.allowed) {
        await service.from('zb_guild_admins').delete().match({ user_id: current.user.id, guild_id: String(guildId) });
        throw new HttpError(decision.status, decision.reason, { code: decision.code });
    }

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

    return { ...current, guild, member, decision };
}
