import 'server-only';
import shared from './shared';
import { createServiceClient } from './supabase/server';
import { getChannels, textChannels, assignableRoles, guildIconUrl } from './discord';
import { env } from './env';

const { defaultGuildConfig, sanitizeStoredConfig, sanitizeStoredMappings } = shared;

export function isHomeGuild(guild) {
    if (!guild) return false;
    if (env.homeGuildIds.includes(String(guild.id))) return true;
    return Boolean(env.botCreatorId) && String(guild.owner_id) === env.botCreatorId;
}

/** Read config through the USER client (RLS applies); seed defaults once if missing. */
export async function loadConfig(supabase, guild) {
    const guildId = String(guild.id);
    const { data, error } = await supabase.from('zb_guild_configs').select('*').eq('guild_id', guildId).maybeSingle();
    if (error) throw new Error(`Config read failed: ${error.message}`);
    if (data) return { ...sanitizeStoredConfig(data, { guildId }), version: data.version, updated_at: data.updated_at };

    // First visit before the bot seeded it: insert safe defaults (service role,
    // only after requireGuildAdmin verified this user for this guild).
    const defaults = defaultGuildConfig({ guildId, legacy: isHomeGuild(guild) });
    delete defaults.version;
    const service = createServiceClient();
    const { error: insertError } = await service.from('zb_guild_configs').upsert(defaults, { onConflict: 'guild_id', ignoreDuplicates: true });
    if (insertError) throw new Error(`Config seed failed: ${insertError.message}`);
    const { data: seeded } = await supabase.from('zb_guild_configs').select('*').eq('guild_id', guildId).maybeSingle();
    return { ...sanitizeStoredConfig(seeded || defaults, { guildId }), version: seeded?.version ?? 1, updated_at: seeded?.updated_at ?? null };
}

export async function loadMappings(supabase, guildId) {
    const { data, error } = await supabase.from('zb_role_mappings').select('*').eq('guild_id', String(guildId)).order('priority', { ascending: false });
    if (error) throw new Error(`Role mappings read failed: ${error.message}`);
    return sanitizeStoredMappings(data || []);
}

export async function loadBotStatus() {
    const service = createServiceClient();
    const { data } = await service.from('zb_bot_heartbeat').select('last_seen_at, guild_count, version').eq('id', 'main').maybeSingle();
    const lastSeen = data?.last_seen_at ? new Date(data.last_seen_at) : null;
    const online = Boolean(lastSeen && Date.now() - lastSeen.getTime() < 3 * 60 * 1000);
    return { online, lastSeen: lastSeen?.toISOString() || null, guildCount: data?.guild_count ?? null, version: data?.version || null };
}

/** Everything the editor needs, all scoped to one verified guild. */
export async function loadGuildBundle({ supabase, guild, decision }) {
    const [config, mappings, channels, botStatus] = await Promise.all([
        loadConfig(supabase, guild),
        loadMappings(supabase, guild.id),
        getChannels(guild.id),
        loadBotStatus()
    ]);
    return {
        guild: {
            id: String(guild.id),
            name: guild.name,
            icon: guildIconUrl(guild.id, guild.icon),
            isOwner: Boolean(decision?.isOwner),
            isHome: isHomeGuild(guild)
        },
        config,
        mappings,
        roles: assignableRoles(guild),
        channels: textChannels(channels),
        botStatus: { installed: true, ...botStatus }
    };
}
