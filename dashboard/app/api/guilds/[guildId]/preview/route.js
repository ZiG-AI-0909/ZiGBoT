import shared from '@/lib/shared';
import { handler, json, readJson, HttpError } from '@/lib/http';
import { requireGuildAdmin } from '@/lib/auth';
import { getChannels } from '@/lib/discord';
import { isHomeGuild } from '@/lib/guildData';
import { env } from '@/lib/env';
import { loadPlan } from '@/lib/billing';

const {
    validateGuildConfig, resolveMemberBehavior, composeSystemPrompt,
    isCrisisMessage, crisisResponse, cleanText, LIMITS, FEATURE_KEYS, TONES, applyPlanToConfig, reviewReply, fallbackReply
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

    // The tester picks which of the three tones to hear; anything else is rejected.
    const tone = body?.tone ?? configResult.value.default_tone;
    if (!TONES.includes(tone)) throw new HttpError(422, `Pick one of these tones: ${TONES.join(', ')}.`);

    // Rate limit (RLS: users can only count/insert their own usage rows).
    const since = new Date(Date.now() - PREVIEW_WINDOW_MS).toISOString();
    const { count, error: countError } = await supabase.from('zb_preview_usage').select('id', { count: 'exact', head: true }).eq('user_id', user.id).gte('created_at', since);
    if (countError) throw new Error(`Preview quota check failed: ${countError.message}`);
    if ((count || 0) >= PREVIEW_LIMIT) throw new HttpError(429, `You can run ${PREVIEW_LIMIT} test messages every 10 minutes. Try again shortly.`);
    const { error: usageError } = await supabase.from('zb_preview_usage').insert({ user_id: user.id, guild_id: String(guild.id) });
    if (usageError) throw new Error(`Preview usage record failed: ${usageError.message}`);

    // Same resolver as the live bot, for a member with no mapped roles, using
    // the chosen tone as the server default.
    // Preview exactly what this server's plan allows (free: no custom persona).
    const { premium } = await loadPlan(guild);
    const config = applyPlanToConfig({ ...configResult.value, default_tone: tone, guild_id: String(guild.id) }, premium);
    const behavior = resolveMemberBehavior({ config, premium });
    const summary = {
        tone: behavior.tone,
        pronouns: behavior.pronouns,
        features: FEATURE_KEYS.filter((f) => behavior.features.has(f))
    };

    if (!config.enabled) return json({ reply: null, note: 'ZiGBoT is switched off for this server, so it would not reply.', summary });
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
    // Same review as the live bot (lib/shared/roast.js). The bot rewrites a
    // failed reply once before using a fixed one; the preview shows the fixed one.
    const text = content.replace(/^\[?ZiGBoT\]?:?\s*/i, '').trim();
    const verdict = reviewReply(text, { tone: behavior.tone, intensity: config.roast_intensity });
    if (!verdict.ok) {
        const why = verdict.kind === 'refusal' ? 'it was a generic refusal' : `it broke a limit (${verdict.reason})`;
        return json({ reply: fallbackReply({ tone: behavior.tone, language: config.language }), note: `The raw reply was not used because ${why}. The live bot rewrites it once in character, and uses a fixed reply like this one if that fails too.`, summary });
    }
    return json({ reply: text.slice(0, 2000), summary });
});
