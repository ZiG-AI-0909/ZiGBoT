import 'server-only';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { HttpError } from '@/lib/http';
import agents from '@/lib/studio/agents';

/**
 * Calls the owner's chosen agent through its official SDK, with the owner's
 * own key. Returns { text, usage: { input, output }, servedBy }.
 * `signal` cancels the request (the owner pressed Cancel or left the page).
 * Keys are never logged; errors are mapped to plain messages.
 */
export async function runAgent({ providerId, model, apiKey, messages, signal }) {
    const { system, turns } = agents.toProviderShape(messages);
    try {
        if (providerId === 'anthropic') return await runClaude({ model, apiKey, system, turns, signal });
        if (providerId === 'openai') return await runOpenAI({ model, apiKey, system, turns, signal });
    } catch (error) {
        throw mapError(providerId, error, signal);
    }
    throw new HttpError(422, 'Pick a supported agent.');
}

async function runClaude({ model, apiKey, system, turns, signal }) {
    const client = new Anthropic({ apiKey, timeout: agents.LIMITS.timeoutMs, maxRetries: 1 });
    // Streaming (large outputs), adaptive thinking (the default on current
    // models), high effort for code, and server-side refusal fallbacks.
    const stream = client.beta.messages.stream({
        model,
        max_tokens: agents.LIMITS.maxOutputTokens,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: 'high' },
        system,
        messages: turns
    }, { signal });
    const message = await stream.finalMessage();
    if (message.stop_reason === 'refusal') throw new HttpError(422, 'The model declined this request. Try rephrasing it.');
    const text = message.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    if (message.stop_reason === 'max_tokens' && !text.includes('}')) throw new HttpError(422, 'The answer was too long and got cut off. Ask for a smaller change.');
    return { text, usage: { input: message.usage?.input_tokens ?? 0, output: message.usage?.output_tokens ?? 0 }, servedBy: message.model || model };
}

async function runOpenAI({ model, apiKey, system, turns, signal }) {
    const client = new OpenAI({ apiKey, timeout: agents.LIMITS.timeoutMs, maxRetries: 1 });
    const response = await client.responses.create({
        model,
        instructions: system,
        input: turns,
        max_output_tokens: agents.LIMITS.maxOutputTokens
    }, { signal });
    return { text: response.output_text || '', usage: { input: response.usage?.input_tokens ?? 0, output: response.usage?.output_tokens ?? 0 }, servedBy: response.model || model };
}

function mapError(providerId, error, signal) {
    if (error instanceof HttpError) return error;
    if (signal?.aborted || error?.name === 'AbortError' || error?.constructor?.name === 'APIUserAbortError') return new HttpError(499, 'Cancelled.', { code: 'cancelled' });
    const name = providerId === 'anthropic' ? 'Anthropic' : 'OpenAI';
    const status = Number(error?.status) || 0;
    if (status === 401 || status === 403) return new HttpError(422, `${name} rejected the API key. Update it in Agent keys.`, { code: 'bad_key' });
    if (status === 404) return new HttpError(422, `${name} does not know that model, or your account cannot use it.`, { code: 'bad_model' });
    if (status === 429) return new HttpError(429, `${name} rate limit or quota reached on your account. Try again later.`, { code: 'provider_rate_limit' });
    if (status === 400) return new HttpError(422, `${name} refused the request (${String(error?.error?.error?.message || error?.message || 'bad request').slice(0, 160)}).`);
    if (/timeout/i.test(String(error?.name) + String(error?.message))) return new HttpError(504, `${name} took too long. Ask for a smaller change.`);
    return new HttpError(502, `Could not reach ${name}. Try again shortly.`);
}
