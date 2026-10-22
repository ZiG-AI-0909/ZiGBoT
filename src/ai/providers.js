/**
 * Chat AI with automatic failover. Looks like an OpenAI client
 * (client.chat.completions.create), so every existing caller works as is,
 * but each request goes to the providers in order and moves on when one fails:
 *
 *   NVIDIA (NVIDIA_API_KEY, model AI_MODEL)        — text chat, intents, roasts
 *   Groq   (GROQ_API_KEY, model GROQ_CHAT_MODEL)   — first for voice chat (fast)
 *
 * Default order is NVIDIA then Groq. Request option `prefer: 'Groq'` moves
 * that provider to the front (voice chat). Either one backs up the other.
 * The caller's `model` is replaced by each provider's own model name.
 * Request option `reasoningLow: true` asks reasoning models (gpt-oss) to think
 * briefly — used for voice chat, where latency matters most.
 */
const OpenAI = require('openai');

const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';
const NVIDIA_BASE_URL = 'https://integrate.api.nvidia.com/v1';
const DEFAULT_GROQ_CHAT_MODEL = 'llama-3.3-70b-versatile';

function buildProviders(settings, { OpenAIClass = OpenAI } = {}) {
    const providers = [];
    if (settings.nvidiaApiKey) {
        providers.push({
            name: 'NVIDIA',
            model: settings.aiModel,
            client: new OpenAIClass({ apiKey: settings.nvidiaApiKey, baseURL: NVIDIA_BASE_URL })
        });
    }
    if (settings.groqApiKey) {
        providers.push({
            name: 'Groq',
            model: settings.groqChatModel || DEFAULT_GROQ_CHAT_MODEL,
            client: new OpenAIClass({ apiKey: settings.groqApiKey, baseURL: GROQ_BASE_URL })
        });
    }
    return providers;
}

function describeError(error) {
    return [error?.status && `status=${error.status}`, error?.error?.message || error?.message].filter(Boolean).join(' ').slice(0, 200);
}

function withReasoningLow(params, model) {
    if (!/gpt-oss/i.test(String(model || '')) || !Array.isArray(params.messages) || params.messages[0]?.role !== 'system') return params;
    const [system, ...rest] = params.messages;
    return { ...params, messages: [{ ...system, content: `Reasoning: low\n${system.content}` }, ...rest] };
}

/** An OpenAI-compatible client that fails over between the configured providers. */
function createChatClient(settings, { providers = buildProviders(settings), logger = console } = {}) {
    if (providers.length === 0) throw new Error('No chat AI configured: set GROQ_API_KEY or NVIDIA_API_KEY.');
    async function create(params, options = {}) {
        const { reasoningLow = false, prefer = null, ...requestOptions } = options || {};
        const ordered = prefer
            ? [...providers.filter((p) => p.name === prefer), ...providers.filter((p) => p.name !== prefer)]
            : providers;
        let lastError;
        for (const [index, provider] of ordered.entries()) {
            let request = { ...params, model: provider.model };
            if (reasoningLow) request = withReasoningLow(request, provider.model);
            try {
                return await provider.client.chat.completions.create(request, Object.keys(requestOptions).length ? requestOptions : undefined);
            } catch (error) {
                lastError = error;
                const next = ordered[index + 1];
                logger.error?.(`[ZiGBoT AI] ${provider.name} (${provider.model}) failed: ${describeError(error)}${next ? ` — trying ${next.name}` : ''}`);
            }
        }
        throw lastError;
    }
    return {
        providers: providers.map(({ name, model }) => ({ name, model })),
        chat: { completions: { create } }
    };
}

/**
 * Startup check: does each key really have access to its configured model?
 * Logs the problem and the models that ARE available, so a wrong model name
 * or a restricted account shows up in the logs instead of as failed replies.
 * Never throws.
 */
async function checkProviders(settings, { fetchImpl = globalThis.fetch, logger = console } = {}) {
    const checks = [];
    if (settings.groqApiKey) checks.push({ name: 'Groq', base: GROQ_BASE_URL, key: settings.groqApiKey, model: settings.groqChatModel || DEFAULT_GROQ_CHAT_MODEL });
    if (settings.nvidiaApiKey) checks.push({ name: 'NVIDIA', base: NVIDIA_BASE_URL, key: settings.nvidiaApiKey, model: settings.aiModel });
    const results = [];
    for (const check of checks) {
        try {
            const response = await fetchImpl(`${check.base}/models`, { headers: { Authorization: `Bearer ${check.key}` }, signal: AbortSignal.timeout(10_000) });
            if (!response.ok) {
                logger.error?.(`[ZiGBoT AI CHECK] ${check.name}: could not list models (HTTP ${response.status}) — check the API key.`);
                results.push({ name: check.name, ok: false });
                continue;
            }
            const ids = ((await response.json())?.data || []).map((m) => String(m.id));
            const ok = ids.includes(check.model);
            if (ok) logger.log?.(`[ZiGBoT AI CHECK] ${check.name}: model ${check.model} is available.`);
            else {
                const chat = ids.filter((id) => !/whisper|tts|orpheus|guard|embed|rerank|vision|parse|safety|retriever|asr|clip/i.test(id));
                logger.error?.(`[ZiGBoT AI CHECK] ${check.name}: model ${check.model} is NOT in this key's model list. Available chat models include: ${chat.slice(0, 25).join(', ') || '(none)'}`);
            }
            results.push({ name: check.name, ok, ids });
        } catch (error) {
            logger.error?.(`[ZiGBoT AI CHECK] ${check.name}: model check failed: ${error.message}`);
            results.push({ name: check.name, ok: false });
        }
    }
    return results;
}

module.exports = { createChatClient, buildProviders, checkProviders, DEFAULT_GROQ_CHAT_MODEL };
