import shared from '@/lib/shared';
import { handler, json, readJson, HttpError } from '@/lib/http';
import { requireGuildAdmin } from '@/lib/auth';
import { getChannels } from '@/lib/discord';
import { isHomeGuild } from '@/lib/guildData';
import { env } from '@/lib/env';

const {
    validateGuildConfig, validateRoleMappings, resolveMemberBehavior, composeSystemPrompt,
    isCrisisMessage, crisisResponse, moderateReplyText, cleanText, LIMITS, FEATURE_KEYS
} = shared;

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const PREVIEW_LIMIT = 10;
const PREVIEW_WINDOW_MS = 10 * 60 * 1000;

// POST: test an UNSAVED draft. Nothing is written except a usage row for rate limiting.
export const POST = handler(async (request, { params }) => {
    const { guildId } = await params;
    const { supabase, user, guild } = await requireGuildAdmin(guildId);
    if (!env.nvidiaApiKey) throw new HttpError(503, 'Preview is unavailable: the AI key is not configured on the dashboard server.');

    const body = await readJson(request);
    const message = cleanText(body?.message);
    if (!message) throw new HttpError(422, 'Type a test message.');
    if (message.length > LIMITS.previewMessage) throw new HttpError(422, `Test messages are limited to ${LIMITS.previewMessage} characters.`);

    const channels = await getChannels(guild.id);
    const configResult = validateGuildConfig(body?.config, { channelIds: new Set(channels.map((c) => String(c.id))), guildId: String(guild.id) });
    if (!configResult.ok) throw new HttpError(422, 'Fix the highlighted settings before testing.', { fieldErrors: configResult.errors });

    const liveRoles = (guild.roles || []).filter((r) => !r.managed);
    const roleIds = new Set(liveRoles.map((r) => String(r.id)));
    const mappingResult = validateRoleMappings(body?.mappings || [], { roleIds, roleNames: new Map(liveRoles.map((r) => [String(r.id), r.name])), guildId: String(guild.id) });
    if (!mappingResult.ok) throw new HttpError(422, 'Fix the role mappings before testing.', { mappingErrors: mappingResult.errors });
    const asRoleIds = (Array.isArray(body?.asRoleIds) ? body.asRoleIds : []).map(String).filter((id) => roleIds.has(id)).slice(0, 25);

    // Rate limit (RLS: users can only count/insert their own usage rows).
    const since = new Date(Date.now() - PREVIEW_WINDOW_MS).toISOString();
    const { count, error: countError } = await supabase.from('zb_preview_usage').select('id', { count: 'exact', head: true }).eq('user_id', user.id).gte('created_at', since);
    if (countError) throw new Error(`Preview quota check failed: ${countError.message}`);
    if ((count || 0) >= PREVIEW_LIMIT) throw new HttpError(429, `You can run ${PREVIEW_LIMIT} test messages every 10 minutes. Try again shortly.`);
    const { error: usageError } = await supabase.from('zb_preview_usage').insert({ user_id: user.id, guild_id: String(guild.id) });
    if (usageError) throw new Error(`Preview usage record failed: ${usageError.message}`);

    const config = { ...configResult.value, guild_id: String(guild.id) };
    const positions = new Map(liveRoles.map((r) => [String(r.id), r.position]));
    const behavior = resolveMemberBehavior({ config, mappings: mappingResult.value, memberRoleIds: asRoleIds, rolePositions: positions });
    const summary = {
        tone: behavior.tone,
        pronouns: behavior.pronouns,
        features: FEATURE_KEYS.filter((f) => behavior.features.has(f)),
        matchedRoles: behavior.matchedRoleIds
    };

    if (!config.enabled) return json({ reply: null, note: 'ZiGBoT is switched off for this server, so it would not reply.', summary });
    if (!behavior.features.has('chat')) return json({ reply: null, note: 'These roles have the "chat" feature denied, so ZiGBoT would ignore this member.', summary });
    // Same code-enforced crisis override as the live bot.
    if (isCrisisMessage(message)) return json({ reply: crisisResponse, note: 'Crisis language always gets this fixed supportive reply, whatever the server settings are.', summary });

    const systemPrompt = composeSystemPrompt({ config, behavior, isHomeGuild: isHomeGuild(guild) });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    let content = '';
    try {
        const response = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
            method: 'POST',
            headers: { Authorization: `Bearer ${env.nvidiaApiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: env.aiModel,
                messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: `[Test user]: ${message}` }],
                temperature: 1,
                top_p: 1,
                max_tokens: 1024,
                stream: false
            }),
            signal: controller.signal,
            cache: 'no-store'
        });
        if (!response.ok) throw new HttpError(502, `The AI provider returned an error (${response.status}). Try again in a moment.`);
        const data = await response.json();
        content = String(data?.choices?.[0]?.message?.content || '').trim();
    } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError(504, error?.name === 'AbortError' ? 'The AI took too long to answer. Try again.' : 'Could not reach the AI provider.');
    } finally {
        clearTimeout(timer);
    }
    if (!content) throw new HttpError(502, 'The AI returned an empty reply. Try again.');
    const moderated = moderateReplyText(content.replace(/^\[?ZiGBoT\]?:?\s*/i, ''));
    if (!moderated.allowed) return json({ reply: 'Nah, I am not saying that one. Ask me something else. 💀', note: `The live guardrail blocked the raw reply (${moderated.reason}).`, summary });
    return json({ reply: moderated.text.slice(0, 2000), summary });
});
