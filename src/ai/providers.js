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
const DEFAULT_GROQ_CHAT_MODEL = 'openai/gpt-oss-20b';
// The SDK defaults (10 min timeout, 2 retries) would leave a user waiting for
// a queued NVIDIA request long before Groq got a turn. NVIDIA's free endpoints
// can stall on cold starts, so it gets no retry: failing over is faster.
// Per-request options (voice chat) still override these.
const NVIDIA_CLIENT_OPTIONS = { timeout: 45_000, maxRetries: 0 };
const GROQ_CLIENT_OPTIONS = { timeout: 45_000, maxRetries: 1 };

function buildProviders(settings, { OpenAIClass = OpenAI } = {}) {
    const providers = [];
    if (settings.nvidiaApiKey) {
        providers.push({
            name: 'NVIDIA',
            model: settings.aiModel,
            client: new OpenAIClass({ apiKey: settings.nvidiaApiKey, baseURL: NVIDIA_BASE_URL, ...NVIDIA_CLIENT_OPTIONS })
        });
    }
    if (settings.groqApiKey) {
        providers.push({
            name: 'Groq',
            model: settings.groqChatModel || DEFAULT_GROQ_CHAT_MODEL,
            client: new OpenAIClass({ apiKey: settings.groqApiKey, baseURL: GROQ_BASE_URL, ...GROQ_CLIENT_OPTIONS })
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

// After a provider fails, later requests try it last for this long, so one
// stalled provider does not add its full timeout to every message.
const PROVIDER_COOLDOWN_MS = 3 * 60_000;

// A 200 response can still carry no usable answer: an empty message, or a
// reasoning model (gpt-oss, DeepSeek) that spent its whole budget thinking.
// That counts as a failure, so the next provider gets a turn.
function hasUsableContent(response) {
    const content = response?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') return false;
    return content.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<think>[\s\S]*$/i, '').trim() !== '';
}

function emptyResponseError(response) {
    const finish = response?.choices?.[0]?.finish_reason;
    const error = new Error(`empty response${finish ? ` (finish_reason=${finish})` : ''}`);
    error.emptyResponse = true;
    return error;
}

/** An OpenAI-compatible client that fails over between the configured providers. */
function createChatClient(settings, { providers = buildProviders(settings), logger = console, now = Date.now } = {}) {
    if (providers.length === 0) throw new Error('No chat AI configured: set GROQ_API_KEY or NVIDIA_API_KEY.');
    const downUntil = new Map();
    const isDown = (provider) => (downUntil.get(provider.name) || 0) > now();
    function markDown(name, ms = PROVIDER_COOLDOWN_MS) {
        downUntil.set(name, now() + ms);
    }
    async function create(params, options = {}) {
        const { reasoningLow = false, prefer = null, ...requestOptions } = options || {};
        const preferred = prefer
            ? [...providers.filter((p) => p.name === prefer), ...providers.filter((p) => p.name !== prefer)]
            : providers;
        // Cooling-down providers stay as a last resort.
        const ordered = [...preferred.filter((p) => !isDown(p)), ...preferred.filter(isDown)];
        let lastError;
        for (const [index, provider] of ordered.entries()) {
            let request = { ...params, model: provider.model };
            if (reasoningLow) request = withReasoningLow(request, provider.model);
            try {
                const response = await provider.client.chat.completions.create(request, Object.keys(requestOptions).length ? requestOptions : undefined);
                if (!hasUsableContent(response)) throw emptyResponseError(response);
                downUntil.delete(provider.name);
                return response;
            } catch (error) {
                lastError = error;
                const next = ordered[index + 1];
                // An empty answer is a one-off, not an outage: no cooldown for it.
                if (next && !error?.emptyResponse) markDown(provider.name);
                const cooldown = error?.emptyResponse ? '' : `; ${provider.name} goes last for ${PROVIDER_COOLDOWN_MS / 60_000} min`;
                logger.error?.(`[ZiGBoT AI] ${provider.name} (${provider.model}) failed: ${describeError(error)}${next ? ` — trying ${next.name}${cooldown}` : ''}`);
            }
        }
        throw lastError;
    }
    return {
        providers: providers.map(({ name, model }) => ({ name, model })),
        markDown,
        chat: { completions: { create } }
    };
}

// Newer chat models to try when the configured one is unusable, best first.
// Matched against the key's own model list; only matches get a test request.
const SUGGESTION_PATTERNS = [/gpt-oss/i, /deepseek-vd/i, /gemma-4/i, /llama-3.3-70b|llama-4/i, /qwen3/i, /nemotron/i, /mistral-(large|medium)/i];
const NON_CHAT = /whisper|tts|orpheus|guard|embed|rerank|vision|parse|safety|retriever|asr|clip|coder|code|diffusion|deplot|kosmos|fuyu/i;

async function answersTestRequest(check, model, fetchImpl) {
    const probe = await fetchImpl(`${check.base}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${check.key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 }),
        signal: AbortSignal.timeout(20_000)
    });
    return { ok: probe.ok, status: probe.status, detail: probe.ok ? '' : String(await probe.text?.() || '').slice(0, 200) };
}

/** Test-calls up to five likely chat models from the key's list; returns the ones that answered. */
async function findWorkingModels(check, ids, fetchImpl) {
    const candidates = [];
    for (const pattern of SUGGESTION_PATTERNS) {
        for (const id of ids) if (pattern.test(id) && !NON_CHAT.test(id) && id !== check.model && !candidates.includes(id)) candidates.push(id);
    }
    const working = [];
    for (const model of candidates.slice(0, 5)) {
        try {
            if ((await answersTestRequest(check, model, fetchImpl)).ok) working.push(model);
        } catch { /* skip */ }
    }
    return working;
}

/**
 * Startup check: does each key really have access to its configured model?
 * Logs the problem and the models that ARE available, so a wrong model name
 * or a restricted account shows up in the logs instead of as failed replies.
 * A listed model can still 404 when used (NVIDIA lists models an account
 * cannot call), so a listed model also gets a one-token test request, and on
 * failure a few likely replacements are test-called and the working ones named.
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
            let ok = false;
            if (!ids.includes(check.model)) {
                logger.error?.(`[ZiGBoT AI CHECK] ${check.name}: model ${check.model} is NOT in this key's model list.`);
            } else {
                let probe;
                try {
                    probe = await answersTestRequest(check, check.model, fetchImpl);
                } catch (error) {
                    if (error?.name !== 'TimeoutError' && error?.name !== 'AbortError') throw error;
                    // The model exists; it is just slow or queued right now (common on
                    // NVIDIA's free endpoints). Test-calling alternatives would stall too.
                    logger.error?.(`[ZiGBoT AI CHECK] ${check.name}: model ${check.model} is listed but did not answer a test request within 20s (slow or overloaded). Requests to it time out after 45s and fail over to the next provider.`);
                    results.push({ name: check.name, ok: false, ids, working: [], slow: true });
                    continue;
                }
                ok = probe.ok;
                if (ok) logger.log?.(`[ZiGBoT AI CHECK] ${check.name}: model ${check.model} is available and answered a test request.`);
                else logger.error?.(`[ZiGBoT AI CHECK] ${check.name}: model ${check.model} is listed but a test request failed (HTTP ${probe.status}): ${probe.detail}`);
            }
            let working = [];
            if (!ok) {
                working = await findWorkingModels(check, ids, fetchImpl);
                logger.error?.(working.length
                    ? `[ZiGBoT AI CHECK] ${check.name}: these models answered a test request — use one: ${working.join(', ')}`
                    : `[ZiGBoT AI CHECK] ${check.name}: no suggested model answered. Chat models on this key include: ${ids.filter((id) => !NON_CHAT.test(id)).slice(0, 25).join(', ') || '(none)'}`);
            }
            results.push({ name: check.name, ok, ids, working });
        } catch (error) {
            logger.error?.(`[ZiGBoT AI CHECK] ${check.name}: model check failed: ${error.message}`);
            results.push({ name: check.name, ok: false });
        }
    }
    return results;
}

module.exports = { createChatClient, buildProviders, checkProviders, hasUsableContent, DEFAULT_GROQ_CHAT_MODEL };
