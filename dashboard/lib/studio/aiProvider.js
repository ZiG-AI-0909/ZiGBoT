import 'server-only';
import { env } from '@/lib/env';
import { HttpError } from '@/lib/http';

/**
 * The dashboard's existing AI provider (the same NVIDIA endpoint, key and
 * model as the server-settings preview route). Returns the model's text.
 * The key is never logged or returned.
 */
export async function completeChat(messages, { timeoutMs = 45_000, maxTokens = 4096 } = {}) {
    if (!env.nvidiaApiKey) throw new HttpError(503, 'The AI creator is unavailable: the AI key is not configured on the dashboard server (NVIDIA_API_KEY).');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
            method: 'POST',
            headers: { Authorization: `Bearer ${env.nvidiaApiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: env.aiModel, messages, temperature: 0.2, top_p: 1, max_tokens: maxTokens, stream: false }),
            signal: controller.signal,
            cache: 'no-store'
        });
        if (!response.ok) throw new HttpError(502, `The AI provider returned an error (${response.status}). Try again in a moment.`);
        const data = await response.json();
        const content = String(data?.choices?.[0]?.message?.content || '').trim();
        if (!content) throw new HttpError(502, 'The AI returned an empty answer. Try again.');
        return content;
    } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError(504, error?.name === 'AbortError' ? 'The AI took too long to answer. Try again.' : 'Could not reach the AI provider.');
    } finally {
        clearTimeout(timer);
    }
}
