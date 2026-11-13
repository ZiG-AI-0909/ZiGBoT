/**
 * "Build with AI Coding Agent" (Platform Phase 7).
 *
 * The owner connects their OWN account with an official API, picks a
 * provider and model, describes what to build, and the agent returns a plan
 * plus file changes. Those become an ordinary AI-creator proposal: shown as
 * diffs, statically checked, and written only after the owner approves.
 * Generated code is never executed on ZiGBoT's servers (it runs only on
 * the owner's paired runner, by the owner's choice).
 *
 * Only official, documented APIs are integrated:
 *   - Claude, via the Anthropic Messages API (official @anthropic-ai/sdk)
 *   - OpenAI models (including Codex-capable ones), via the OpenAI
 *     Responses API (official openai SDK)
 * Not integrated, and shown as such with the reason: GitHub Copilot (no
 * public code-generation API), and the Claude Code / Codex command-line
 * agents (they run shell commands, which would need an isolated sandbox).
 */
const ai = require('./aiCreator');

const PROVIDERS = Object.freeze({
    anthropic: Object.freeze({
        id: 'anthropic',
        label: 'Claude (Anthropic API)',
        keyHint: 'An Anthropic API key from console.anthropic.com (starts with sk-ant-).',
        keyPattern: /^sk-ant-[A-Za-z0-9_-]{20,200}$/,
        // Current Claude models (exact IDs); Opus is the default.
        models: Object.freeze(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']),
        defaultModel: 'claude-opus-5-5'
    }),
    openai: Object.freeze({
        id: 'openai',
        label: 'OpenAI API (incl. Codex models)',
        keyHint: 'An OpenAI API key from platform.openai.com (starts with sk-).',
        keyPattern: /^sk-[A-Za-z0-9_-]{20,250}$/,
        // OpenAI's model list changes often: the owner types the model their account can use.
        models: null,
        defaultModel: null
    })
});

const NOT_AVAILABLE = Object.freeze([
    { id: 'copilot', label: 'GitHub Copilot', reason: 'GitHub does not offer a public API for generating code with Copilot, so it cannot be connected here.' },
    { id: 'claude-code', label: 'Claude Code (command-line agent)', reason: 'It runs shell commands on a machine, which needs an isolated sandbox Studio does not have yet. Use Claude through the Anthropic API above.' },
    { id: 'codex-cli', label: 'OpenAI Codex CLI', reason: 'Same as Claude Code: a terminal agent that runs commands. Use OpenAI models through the API above.' }
]);

const PROJECT_TYPES = Object.freeze([
    { id: 'feature', label: 'Add a feature' },
    { id: 'command', label: 'New slash command' },
    { id: 'project', label: 'Build out a whole bot' },
    { id: 'fix', label: 'Fix or debug something' },
    { id: 'refactor', label: 'Clean up / refactor' }
]);

const LIMITS = Object.freeze({ runsPerDay: 50, maxOutputTokens: 64000, timeoutMs: 290_000 });
const MODEL_ID = /^[a-z0-9][a-z0-9._:-]{1,63}$/i;

/** { provider, model } or { error }. Never trusts a model string blindly. */
function resolveModel(providerId, model) {
    const p = PROVIDERS[providerId];
    if (!p) return { error: 'Pick a supported agent.' };
    const m = String(model ?? '').trim() || p.defaultModel;
    if (!m) return { error: 'Type the OpenAI model your account can use (see your OpenAI dashboard).' };
    if (p.models && !p.models.includes(m)) return { error: `Pick one of: ${p.models.join(', ')}.` };
    if (!MODEL_ID.test(m)) return { error: 'That model name has unexpected characters.' };
    return { provider: p, model: m };
}

function validateKey(providerId, apiKey) {
    const p = PROVIDERS[providerId];
    if (!p) return 'Pick a supported agent.';
    const key = String(apiKey ?? '').trim();
    if (!p.keyPattern.test(key)) return `That does not look like a valid key. ${p.keyHint}`;
    return null;
}

/** Chat messages for the agent: the AI creator's (untrusted data, project-only context) plus the task type. */
function buildAgentMessages({ request, files, framework, specialization, projectType }) {
    const type = PROJECT_TYPES.find((t) => t.id === projectType) || PROJECT_TYPES[0];
    const msgs = ai.buildMessages({ request, files, framework, specialization });
    msgs[0] = { role: 'system', content: `${msgs[0].content}\nTask type chosen by the owner: ${type.label}.` };
    return msgs;
}

/** Split into a system string + user turns (the shape both official APIs take). */
function toProviderShape(msgs) {
    return { system: msgs[0].content, turns: msgs.slice(1).map((m) => ({ role: 'user', content: m.content })) };
}

/** Encryption binding for a user's agent key: sealed for this user + provider only. */
const keyAad = (ownerId, provider) => require('./secrets').aadFor(`user:${ownerId}`, `AGENT_${String(provider).toUpperCase()}`);

module.exports = { keyAad, PROVIDERS, NOT_AVAILABLE, PROJECT_TYPES, LIMITS, resolveModel, validateKey, buildAgentMessages, toProviderShape };
