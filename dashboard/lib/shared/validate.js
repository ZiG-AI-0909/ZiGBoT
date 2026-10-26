/**
 * Backend validation for administrator-provided configuration.
 * Used by the dashboard API routes (before every write) and by the bot
 * (defensively, on every config it loads from the database).
 *
 * Unknown fields are dropped — an admin can never set guild_id, version,
 * timestamps, or anything outside this whitelist.
 */
const {
    FEATURE_KEYS, TONES, TIERS, PRONOUNS, RESPONSE_LENGTHS, LIMITS, VOICE_SPEAKERS, VOICE_LANGUAGES
} = require('./constants');
const { defaultGuildConfig } = require('./defaults');
const { LANGUAGE_VALUES, DEFAULT_LANGUAGE } = require('./languages');
const { validateGifSettings, sanitizeGifSettings } = require('./gifs');

const SNOWFLAKE = /^\d{17,20}$/;

const TEXT_LIMITS = Object.freeze({
    custom_system_prompt: LIMITS.customSystemPrompt,
    response_instructions: LIMITS.responseInstructions,
    server_rules: LIMITS.serverRules,
    language: LIMITS.language,
    response_style: LIMITS.responseStyle
});

// Attempts to switch off the platform safety layer are rejected outright.
// (The safety layer is also enforced in code, so this is defence in depth.)
const OVERRIDE_PATTERNS = [
    /\b(ignore|disregard|override|bypass|forget)\b[^.\n]{0,30}\b(all\s+)?(previous|prior|above|earlier|platform|system|safety|zigbot)\b[^.\n]{0,20}\b(instructions?|rules?|guidelines?|prompts?|guardrails?|restrictions?)\b/i,
    /\b(no|without)\s+(safety\s+)?(guardrails|restrictions|filters|content\s+polic(y|ies))\b/i,
    /\byou\s+(are|have)\s+(now\s+)?(unrestricted|jailbroken|no\s+rules)\b/i,
    /\b(grant|give)\b[^.\n]{0,30}\b(admin(istrator)?|ban|kick|moderator)\b[^.\n]{0,20}\b(permissions?|rights|access)\b/i
];

// Secrets must never be pasted into prompts (they would reach the AI provider
// and every future reply context).
const SECRET_PATTERNS = [
    /[MN][A-Za-z\d_-]{23,27}\.[\w-]{6}\.[\w-]{27,}/, // Discord bot token
    /\bnvapi-[A-Za-z0-9_-]{20,}/,
    /\bsk-[A-Za-z0-9_-]{20,}/,
    /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, // JWT / Supabase keys
    /mongodb(\+srv)?:\/\/[^\s:]+:[^\s@]+@/i,
    /postgres(ql)?:\/\/[^\s:]+:[^\s@]+@/i
];

function cleanText(value) {
    return String(value ?? '')
        .replace(/\r\n?/g, '\n')
        // strip control chars except tab/newline, and zero-width/bidi tricks
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​-‏‪-‮⁦-⁩]/g, '')
        .trim();
}

function checkText(errors, field, raw, max) {
    if (raw === undefined || raw === null) return '';
    if (typeof raw !== 'string') {
        errors[field] = 'Must be text.';
        return '';
    }
    const text = cleanText(raw);
    if (text.length > max) {
        errors[field] = `Must be ${max} characters or fewer (currently ${text.length}).`;
        return text.slice(0, max);
    }
    if (OVERRIDE_PATTERNS.some((pattern) => pattern.test(text))) {
        errors[field] = 'Instructions cannot disable ZiGBoT safety rules or grant permissions. Describe tone and behaviour instead.';
    } else if (SECRET_PATTERNS.some((pattern) => pattern.test(text))) {
        errors[field] = 'This looks like a token, API key or password. Never put secrets into AI instructions.';
    }
    return text;
}

function checkBool(errors, field, raw, fallback) {
    if (raw === undefined) return fallback;
    if (typeof raw !== 'boolean') {
        errors[field] = 'Must be true or false.';
        return fallback;
    }
    return raw;
}

function checkEnum(errors, field, raw, allowed, fallback, { nullable = false } = {}) {
    if (raw === undefined) return fallback;
    if (nullable && (raw === null || raw === '')) return null;
    if (!allowed.includes(raw)) {
        errors[field] = `Must be one of: ${allowed.join(', ')}.`;
        return fallback;
    }
    return raw;
}

function checkInt(errors, field, raw, min, max, fallback) {
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) {
        errors[field] = `Must be a whole number between ${min} and ${max}.`;
        return fallback;
    }
    return n;
}

function checkIdList(errors, field, raw, knownIds) {
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw)) {
        errors[field] = 'Must be a list of IDs.';
        return [];
    }
    if (raw.length > LIMITS.channelsPerList) {
        errors[field] = `At most ${LIMITS.channelsPerList} entries.`;
        return [];
    }
    const out = [];
    for (const id of raw) {
        const value = String(id);
        if (!SNOWFLAKE.test(value)) {
            errors[field] = `"${value.slice(0, 30)}" is not a valid Discord ID.`;
            return [];
        }
        if (knownIds && !knownIds.has(value)) {
            errors[field] = `ID ${value} does not belong to this server.`;
            return [];
        }
        if (!out.includes(value)) out.push(value);
    }
    return out;
}

/**
 * Validate a full guild config submitted by an admin.
 * @param {object} input raw request body
 * @param {{channelIds?: Set<string>, guildId?: string}} ctx trusted, server-fetched context
 */
function validateGuildConfig(input, ctx = {}) {
    const errors = {};
    const base = defaultGuildConfig({ guildId: ctx.guildId });
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return { ok: false, errors: { _: 'Config must be an object.' }, value: null };
    }
    const channels = ctx.channelIds || null;
    const value = {
        enabled: checkBool(errors, 'enabled', input.enabled, base.enabled),
        default_tone: checkEnum(errors, 'default_tone', input.default_tone, TONES, base.default_tone),
        replace_base_persona: checkBool(errors, 'replace_base_persona', input.replace_base_persona, false),
        custom_system_prompt: checkText(errors, 'custom_system_prompt', input.custom_system_prompt, LIMITS.customSystemPrompt),
        response_instructions: checkText(errors, 'response_instructions', input.response_instructions, LIMITS.responseInstructions),
        server_rules: checkText(errors, 'server_rules', input.server_rules, LIMITS.serverRules),
        // Only the supported languages (lib/shared/languages.js) can be saved;
        // '' = "not chosen yet" (a new server's default, which keeps the
        // original persona), so the stored defaults stay valid.
        language: input.language === '' || input.language === null ? '' : checkEnum(errors, 'language', input.language, LANGUAGE_VALUES, DEFAULT_LANGUAGE),
        response_style: checkText(errors, 'response_style', input.response_style, LIMITS.responseStyle),
        response_length: checkEnum(errors, 'response_length', input.response_length, RESPONSE_LENGTHS, base.response_length),
        respond_to_all: checkBool(errors, 'respond_to_all', input.respond_to_all, base.respond_to_all),
        auto_reply_keywords: checkBool(errors, 'auto_reply_keywords', input.auto_reply_keywords, base.auto_reply_keywords),
        cooldown_seconds: checkInt(errors, 'cooldown_seconds', input.cooldown_seconds, LIMITS.cooldownMin, LIMITS.cooldownMax, base.cooldown_seconds),
        allowed_channel_ids: checkIdList(errors, 'allowed_channel_ids', input.allowed_channel_ids, channels),
        chat_channel_ids: checkIdList(errors, 'chat_channel_ids', input.chat_channel_ids, channels),
        blocked_channel_ids: checkIdList(errors, 'blocked_channel_ids', input.blocked_channel_ids, channels),
        log_channel_id: null,
        memory_enabled: checkBool(errors, 'memory_enabled', input.memory_enabled, base.memory_enabled),
        reputation_enabled: checkBool(errors, 'reputation_enabled', input.reputation_enabled, base.reputation_enabled),
        music_enabled: checkBool(errors, 'music_enabled', input.music_enabled, base.music_enabled),
        voice_enabled: checkBool(errors, 'voice_enabled', input.voice_enabled, base.voice_enabled),
        legacy_role_rules: checkBool(errors, 'legacy_role_rules', input.legacy_role_rules, false),
        music_dj_role_ids: checkIdList(errors, 'music_dj_role_ids', input.music_dj_role_ids, ctx.roleIds || null).slice(0, 10),
        music_channel_id: null,
        music_idle_minutes: checkInt(errors, 'music_idle_minutes', input.music_idle_minutes, 1, 60, base.music_idle_minutes),
        music_default_volume: checkInt(errors, 'music_default_volume', input.music_default_volume, 1, 100, base.music_default_volume),
        voice_speaker: input.voice_speaker === undefined || input.voice_speaker === null || input.voice_speaker === '' ? '' : checkEnum(errors, 'voice_speaker', input.voice_speaker, VOICE_SPEAKERS, ''),
        voice_pace: checkInt(errors, 'voice_pace', input.voice_pace, 50, 200, base.voice_pace),
        voice_language: checkEnum(errors, 'voice_language', input.voice_language, VOICE_LANGUAGES, base.voice_language),
        voice_speak_replies: checkBool(errors, 'voice_speak_replies', input.voice_speak_replies, base.voice_speak_replies),
        owner_roast: checkBool(errors, 'owner_roast', input.owner_roast, base.owner_roast),
        // Server setup (also set by the bot's /setup command).
        owner_pronouns: input.owner_pronouns === undefined || input.owner_pronouns === null || input.owner_pronouns === '' ? null : checkEnum(errors, 'owner_pronouns', input.owner_pronouns, PRONOUNS, null),
        male_role_ids: checkIdList(errors, 'male_role_ids', input.male_role_ids, ctx.roleIds || null).slice(0, 10),
        female_role_ids: checkIdList(errors, 'female_role_ids', input.female_role_ids, ctx.roleIds || null).slice(0, 10),
        adult_role_ids: checkIdList(errors, 'adult_role_ids', input.adult_role_ids, ctx.roleIds || null).slice(0, 10),
        minor_role_ids: checkIdList(errors, 'minor_role_ids', input.minor_role_ids, ctx.roleIds || null).slice(0, 10),
        gif_settings: null
    };
    const gifs = validateGifSettings(input.gif_settings, { channelIds: channels });
    if (gifs.error) errors.gif_settings = gifs.error;
    value.gif_settings = gifs.value;
    for (const field of ['male_role_ids', 'female_role_ids', 'adult_role_ids', 'minor_role_ids']) {
        if (value[field].includes(String(ctx.guildId))) errors[field] = '@everyone cannot be used here.';
    }
    if (value.male_role_ids.some((id) => value.female_role_ids.includes(id))) errors.female_role_ids = 'A role cannot be both male and female.';
    if (value.adult_role_ids.some((id) => value.minor_role_ids.includes(id))) errors.minor_role_ids = 'A role cannot be both 18+ and under 18.';
    if (input.music_channel_id !== undefined && input.music_channel_id !== null && input.music_channel_id !== '') {
        const [id] = checkIdList(errors, 'music_channel_id', [input.music_channel_id], channels);
        value.music_channel_id = id || null;
    }
    if (value.music_dj_role_ids.includes(String(ctx.guildId))) errors.music_dj_role_ids = '@everyone cannot be the DJ role.';
    if (input.log_channel_id !== undefined && input.log_channel_id !== null && input.log_channel_id !== '') {
        const [id] = checkIdList(errors, 'log_channel_id', [input.log_channel_id], channels);
        value.log_channel_id = id || null;
    }
    if (value.replace_base_persona && !value.custom_system_prompt) {
        errors.custom_system_prompt = 'Write a custom persona prompt, or turn off "replace ZiGBoT persona".';
    }
    const blocked = new Set(value.blocked_channel_ids);
    const clash = value.chat_channel_ids.find((id) => blocked.has(id)) || value.allowed_channel_ids.find((id) => blocked.has(id));
    if (clash) errors.blocked_channel_ids = `Channel ${clash} cannot be both blocked and allowed.`;

    const ok = Object.keys(errors).length === 0;
    return { ok, errors, value: ok ? value : null };
}

function checkFeatureList(errors, field, raw) {
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw)) {
        errors[field] = 'Must be a list.';
        return [];
    }
    const out = [];
    for (const feature of raw) {
        if (!FEATURE_KEYS.includes(feature)) {
            errors[field] = `Unknown feature "${String(feature).slice(0, 30)}".`;
            return [];
        }
        if (!out.includes(feature)) out.push(feature);
    }
    return out;
}

/**
 * Validate the full list of role mappings for a guild.
 * @param {Array} input
 * @param {{roleIds?: Set<string>, roleNames?: Map<string,string>, guildId?: string}} ctx trusted, live from Discord
 */
function validateRoleMappings(input, ctx = {}) {
    if (!Array.isArray(input)) return { ok: false, errors: [{ _: 'Role mappings must be a list.' }], value: null };
    if (input.length > LIMITS.roleMappingsPerGuild) {
        return { ok: false, errors: [{ _: `At most ${LIMITS.roleMappingsPerGuild} role mappings.` }], value: null };
    }
    const seen = new Set();
    const allErrors = [];
    const value = input.map((raw, index) => {
        const errors = {};
        const roleId = String(raw?.role_id ?? '');
        if (!SNOWFLAKE.test(roleId)) errors.role_id = 'Pick a role.';
        else if (ctx.roleIds && !ctx.roleIds.has(roleId)) errors.role_id = 'That role does not exist in this server.';
        else if (ctx.guildId && roleId === String(ctx.guildId)) errors.role_id = 'Use the server defaults instead of mapping @everyone.';
        else if (seen.has(roleId)) errors.role_id = 'This role is mapped twice.';
        seen.add(roleId);

        const mapping = {
            role_id: roleId,
            // Display name comes from Discord, never from the browser.
            role_name: ctx.roleNames?.get(roleId) || '',
            tier: checkEnum(errors, 'tier', raw?.tier, TIERS, 'custom'),
            priority: checkInt(errors, 'priority', raw?.priority ?? 0, LIMITS.priorityMin, LIMITS.priorityMax, 0),
            tone: checkEnum(errors, 'tone', raw?.tone ?? null, TONES, null, { nullable: true }),
            pronouns: checkEnum(errors, 'pronouns', raw?.pronouns ?? null, PRONOUNS, null, { nullable: true }),
            instructions: checkText(errors, 'instructions', raw?.instructions, LIMITS.roleInstructions),
            allowed_features: checkFeatureList(errors, 'allowed_features', raw?.allowed_features),
            denied_features: checkFeatureList(errors, 'denied_features', raw?.denied_features)
        };
        const both = mapping.allowed_features.find((f) => mapping.denied_features.includes(f));
        if (both) errors.denied_features = `"${both}" cannot be both allowed and denied.`;
        if (Object.keys(errors).length > 0) allErrors[index] = errors;
        return mapping;
    });
    const ok = allErrors.length === 0;
    return { ok, errors: allErrors, value: ok ? value : null };
}

/**
 * Bot-side: coerce whatever is in the DB into a safe config. Invalid fields
 * fall back to defaults instead of crashing the bot.
 */
function sanitizeStoredConfig(row, { guildId } = {}) {
    const defaults = defaultGuildConfig({ guildId });
    if (!row || typeof row !== 'object') return defaults;
    const out = { ...defaults };
    for (const key of Object.keys(defaults)) {
        if (row[key] === undefined || row[key] === null) continue;
        const expected = typeof defaults[key];
        if (Array.isArray(defaults[key])) {
            if (Array.isArray(row[key])) out[key] = row[key].map(String).filter((id) => SNOWFLAKE.test(id));
        } else if (key === 'log_channel_id' || key === 'music_channel_id') {
            out[key] = SNOWFLAKE.test(String(row[key])) ? String(row[key]) : null;
        } else if (key === 'gif_settings') {
            out[key] = sanitizeGifSettings(row[key]);
        } else if (key === 'owner_pronouns') {
            out[key] = PRONOUNS.includes(row[key]) ? row[key] : null;
        } else if (expected === typeof row[key]) {
            out[key] = row[key];
        }
    }
    if (!TONES.includes(out.default_tone)) out.default_tone = defaults.default_tone;
    if (!RESPONSE_LENGTHS.includes(out.response_length)) out.response_length = defaults.response_length;
    for (const [key, limit] of Object.entries(TEXT_LIMITS)) {
        out[key] = cleanText(out[key]).slice(0, limit);
    }
    if (out.voice_speaker && !VOICE_SPEAKERS.includes(out.voice_speaker)) out.voice_speaker = '';
    if (!VOICE_LANGUAGES.includes(out.voice_language)) out.voice_language = 'auto';
    out.voice_pace = Math.min(200, Math.max(50, Math.round(out.voice_pace) || 100));
    out.music_idle_minutes = Math.min(60, Math.max(1, Math.round(out.music_idle_minutes) || defaults.music_idle_minutes));
    out.music_default_volume = Math.min(100, Math.max(1, Math.round(out.music_default_volume) || defaults.music_default_volume));
    out.guild_id = String(guildId ?? row.guild_id ?? '');
    return out;
}

function sanitizeStoredMappings(rows) {
    if (!Array.isArray(rows)) return [];
    return rows
        .filter((row) => row && SNOWFLAKE.test(String(row.role_id)))
        .map((row) => ({
            role_id: String(row.role_id),
            role_name: String(row.role_name || ''),
            tier: TIERS.includes(row.tier) ? row.tier : 'custom',
            priority: Number.isInteger(row.priority) ? row.priority : 0,
            tone: TONES.includes(row.tone) ? row.tone : null,
            pronouns: PRONOUNS.includes(row.pronouns) ? row.pronouns : null,
            instructions: cleanText(row.instructions).slice(0, LIMITS.roleInstructions),
            allowed_features: Array.isArray(row.allowed_features) ? row.allowed_features.filter((f) => FEATURE_KEYS.includes(f)) : [],
            denied_features: Array.isArray(row.denied_features) ? row.denied_features.filter((f) => FEATURE_KEYS.includes(f)) : []
        }));
}

module.exports = {
    SNOWFLAKE,
    cleanText,
    validateGuildConfig,
    validateRoleMappings,
    sanitizeStoredConfig,
    sanitizeStoredMappings
};
