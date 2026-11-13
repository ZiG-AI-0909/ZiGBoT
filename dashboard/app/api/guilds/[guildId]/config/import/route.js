import shared from '@/lib/shared';
import { handler, json, HttpError } from '@/lib/http';
import { requireGuildAdmin } from '@/lib/auth';
import { getChannels } from '@/lib/discord';
import { loadPlan } from '@/lib/billing';
import porting from '@/lib/shared/configPorting';

const { validateGuildConfig, sanitizeStoredConfig, configPremiumErrors } = shared;

export const dynamic = 'force-dynamic';

// POST (raw JSON file body): restore settings from an export. Server owner
// only. Runs the SAME validation and Premium checks as a normal save
// (config/route.js PUT), against THIS server's live channels and roles, and
// writes through the user's RLS-scoped client. Ids that do not exist here
// are rejected, so a backup from another server cannot point anywhere.
export const POST = handler(async (request, { params }) => {
    const { guildId } = await params;
    const { supabase, guild, decision } = await requireGuildAdmin(guildId);
    if (!decision?.isOwner) throw new HttpError(403, 'Only the server owner can import settings.');
    const text = await request.text();
    const parsed = porting.parseImport(text);
    if (parsed.error) throw new HttpError(422, parsed.error);

    const channels = await getChannels(guild.id);
    const channelIds = new Set(channels.map((c) => String(c.id)));
    const channelTypes = new Map(channels.map((channel) => [String(channel.id), channel.type]));
    const roleIds = new Set((guild.roles || []).filter((r) => !r.managed).map((r) => String(r.id)));
    const result = validateGuildConfig(parsed.config, { channelIds, channelTypes, roleIds, guildId: String(guild.id) });
    if (!result.ok) throw new HttpError(422, 'The backup does not fit this server (see the fields).', { fieldErrors: result.errors });

    const plan = await loadPlan(guild);
    if (!plan.premium) {
        const { data: stored } = await supabase.from('zb_guild_configs').select('custom_system_prompt, replace_base_persona, gif_settings').eq('guild_id', String(guild.id)).maybeSingle();
        const gifStyle = result.value.gif_settings?.custom_style || '';
        const premiumErrors = configPremiumErrors({
            custom_system_prompt: result.value.custom_system_prompt !== (stored?.custom_system_prompt || '') ? result.value.custom_system_prompt : '',
            replace_base_persona: Boolean(result.value.replace_base_persona) !== Boolean(stored?.replace_base_persona) ? result.value.replace_base_persona : false,
            gif_custom_style: gifStyle !== (stored?.gif_settings?.custom_style || '') ? gifStyle : ''
        });
        if (Object.keys(premiumErrors).length > 0) throw new HttpError(403, 'That backup uses Premium settings this server does not have.', { fieldErrors: premiumErrors });
    }
    const { data, error } = await supabase.from('zb_guild_configs').update(result.value).eq('guild_id', String(guild.id)).select('*');
    if (error) throw new Error(`Config import failed: ${error.message}`);
    if (!data || data.length === 0) throw new HttpError(409, 'The settings could not be saved. Reload and try again.');
    const row = data[0];
    return json({ config: { ...sanitizeStoredConfig(row, { guildId: String(guild.id) }), version: row.version, updated_at: row.updated_at } });
});
