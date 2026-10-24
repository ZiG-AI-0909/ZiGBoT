const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// Startup must require only the chat AI key for the provider actually in use
// (Groq-only deployments must boot), and fail clearly when no provider is set.
const { loadSettings } = require('../src/config/settings');
const { buildProviders } = require('../src/ai/providers');

const KEYS = ['DISCORD_TOKEN', 'GROQ_API_KEY', 'NVIDIA_API_KEY'];

function withEnv(values, fn) {
    const saved = Object.fromEntries(KEYS.map((name) => [name, process.env[name]]));
    try {
        for (const name of KEYS) {
            if (values[name] === undefined) delete process.env[name];
            else process.env[name] = values[name];
        }
        return fn();
    } finally {
        for (const [name, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
    }
}

class FakeOpenAI {
    constructor(options) { this.options = options; }
}

test('with only the Groq key set, settings load and only Groq is used for chat', () => {
    const settings = withEnv({ DISCORD_TOKEN: 'token', GROQ_API_KEY: 'groq-key' }, () => loadSettings());
    assert.equal(settings.groqApiKey, 'groq-key');
    assert.equal(settings.nvidiaApiKey, '');
    const providers = buildProviders(settings, { OpenAIClass: FakeOpenAI });
    assert.deepEqual(providers.map((p) => p.name), ['Groq']);
});

test('NVIDIA-only and both-key setups still load (no provider support removed)', () => {
    const nvidia = withEnv({ DISCORD_TOKEN: 'token', NVIDIA_API_KEY: 'nvidia-key' }, () => loadSettings());
    assert.deepEqual(buildProviders(nvidia, { OpenAIClass: FakeOpenAI }).map((p) => p.name), ['NVIDIA']);
    const both = withEnv({ DISCORD_TOKEN: 'token', NVIDIA_API_KEY: 'nvidia-key', GROQ_API_KEY: 'groq-key' }, () => loadSettings());
    assert.deepEqual(buildProviders(both, { OpenAIClass: FakeOpenAI }).map((p) => p.name), ['NVIDIA', 'Groq']);
});

test('with neither chat key set, loading fails with a clear message', () => {
    const expected = /No chat AI provider configured: set GROQ_API_KEY \(Groq\) or NVIDIA_API_KEY \(NVIDIA\)\. At least one is required/;
    assert.throws(() => withEnv({ DISCORD_TOKEN: 'token' }, () => loadSettings()), expected);
    // Whitespace-only values do not count as configured.
    assert.throws(() => withEnv({ DISCORD_TOKEN: 'token', GROQ_API_KEY: '   ', NVIDIA_API_KEY: '' }, () => loadSettings()), expected);
});

test('DISCORD_TOKEN is still required', () => {
    assert.throws(
        () => withEnv({ GROQ_API_KEY: 'groq-key' }, () => loadSettings()),
        /Missing required environment variables: DISCORD_TOKEN$/
    );
});

test('bot startup with neither chat key exits non-zero with the clear message', () => {
    // Empty working directory (no .env for dotenv to load) and a minimal
    // environment: the process must stop at settings, before any network use.
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'zigbot-startup-'));
    try {
        const env = { PATH: process.env.PATH, DISCORD_TOKEN: 'token', PORT: '0', NODE_TEST_CONTEXT: 'child' };
        if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
        const result = spawnSync(process.execPath, [path.join(__dirname, '..', 'index.js')], { cwd, env, encoding: 'utf8', timeout: 30_000 });
        assert.notEqual(result.status, 0, 'startup must fail');
        assert.match(result.stderr, /No chat AI provider configured: set GROQ_API_KEY \(Groq\) or NVIDIA_API_KEY \(NVIDIA\)/);
        assert.doesNotMatch(result.stderr, /Missing required environment variables: .*NVIDIA_API_KEY/);
    } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
    }
});
