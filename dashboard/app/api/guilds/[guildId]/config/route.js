import shared from '@/lib/shared';
import { handler, json, readJson, HttpError } from '@/lib/http';
import { requireGuildAdmin } from '@/lib/auth';
import { getChannels } from '@/lib/discord';
import { loadConfig } from '@/lib/guildData';
import { loadPlan } from '@/lib/billing';

const { validateGuildConfig, sanitizeStoredConfig, configPremiumErrors } = shared;

export const dynamic = 'force-dynamic';

export const GET = handler(async (_request, { params }) => {
    const { guildId } = await params;
    const { supabase, guild } = await requireGuildAdmin(guildId);
    return json({ config: await loadConfig(supabase, guild) });
});

// PUT: validate against LIVE channel ids of this guild, then write through
// the user's RLS-scoped client (RLS re-checks the fresh admin verification).
export const PUT = handler(async (request, { params }) => {
    const { guildId } = await params;
    const { supabase, guild } = await requireGuildAdmin(guildId);
    const body = await readJson(request);
    const channels = await getChannels(guild.id);
    const channelIds = new Set(channels.map((c) => String(c.id)));
    const categoryIds = new Set(channels.filter((c) => c.type === 4).map((c) => String(c.id)));
    const channelTypes = new Map(channels.map((channel) => [String(channel.id), channel.type]));
    // DJ roles: real, non-managed roles of THIS guild (from Discord, not the request).
    const roleIds = new Set((guild.roles || []).filter((r) => !r.managed).map((r) => String(r.id)));
    // Older dashboard builds offered voice channels in this optional category
    // picker. If the hub itself was selected there, treat it as the default:
    // newly-created channels inherit the hub's parent category in tempVoice.js.
    const submittedConfig = body?.config && typeof body.config === 'object' ? { ...body.config } : body?.config;
    const voiceSettings = submittedConfig?.feature_settings?.voice;
    if (voiceSettings?.tempvoice_category_id && String(voiceSettings.tempvoice_category_id) === String(voiceSettings.tempvoice_hub_channel_id)) {
        submittedConfig.feature_settings = { ...submittedConfig.feature_settings, voice: { ...voiceSettings, tempvoice_category_id: null } };
    }
    const result = validateGuildConfig(submittedConfig, { channelIds, categoryIds, channelTypes, roleIds, guildId: String(guild.id) });
    if (!result.ok) throw new HttpError(422, 'Some settings need fixing.', { fieldErrors: result.errors });

    // Free servers cannot add or change Premium settings. Values saved while
    // the server was Premium may stay (the bot ignores them until it is
    // Premium again), so a lapsed server can still edit everything else.
    const plan = await loadPlan(guild);
    if (!plan.premium) {
        const { data: stored } = await supabase.from('zb_guild_configs').select('custom_system_prompt, replace_base_persona, gif_settings').eq('guild_id', String(guild.id)).maybeSingle();
        const gifStyle = result.value.gif_settings?.custom_style || '';
        const changed = {
            custom_system_prompt: result.value.custom_system_prompt !== (stored?.custom_system_prompt || '') ? result.value.custom_system_prompt : '',
            replace_base_persona: Boolean(result.value.replace_base_persona) !== Boolean(stored?.replace_base_persona) ? result.value.replace_base_persona : false,
            gif_custom_style: gifStyle !== (stored?.gif_settings?.custom_style || '') ? gifStyle : ''
        };
        const premiumErrors = configPremiumErrors(changed);
        if (Object.keys(premiumErrors).length > 0) throw new HttpError(403, 'That needs ZiGBoT Premium for this server.', { fieldErrors: premiumErrors });
    }

    // Optimistic concurrency: refuse to overwrite a newer save from another admin.
    let query = supabase.from('zb_guild_configs').update(result.value).eq('guild_id', String(guild.id));
    if (Number.isInteger(body?.expectedVersion)) query = query.eq('version', body.expectedVersion);
    const { data, error } = await query.select('*');
    if (error) {
        // A column the dashboard writes but the database lacks = a migration
        // in supabase/migrations was not run. Say so instead of a generic error.
        const failure = new Error(`Config update failed: ${error.message}`);
        if (/column|schema cache/i.test(error.message || '')) {
            failure.publicMessage = `The database is missing new settings (${error.message}). Run the newest files in supabase/migrations in the Supabase SQL Editor, then save again.`;
        }
        throw failure;
    }
    if (!data || data.length === 0) {
        const { data: current } = await supabase.from('zb_guild_configs').select('version, updated_at').eq('guild_id', String(guild.id)).maybeSingle();
        throw new HttpError(409, 'Someone else saved changes to this server in the meantime. Your draft is still here; review it and save again.', {
            currentVersion: current?.version ?? null,
            updatedAt: current?.updated_at ?? null
        });
    }
    const row = data[0];
    return json({ config: { ...sanitizeStoredConfig(row, { guildId: String(guild.id) }), version: row.version, updated_at: row.updated_at } });
});
