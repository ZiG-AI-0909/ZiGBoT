/**
 * Reaction GIFs: the per-persona rules shared by the bot (which GIF, if any)
 * and the dashboard (save-time validation). CommonJS, like lib/shared.
 *
 *  - Styles are a closed list. The AI may only pick a style id from the
 *    list its mode allows; code turns that into a fixed search query. Member
 *    text is never searched.
 *  - Gentle can never roast; under-18 members always get Gentle rules.
 *  - A custom persona's "GIF style" (Premium) is added to the query only
 *    after passing the same filters as everything else.
 */
const { offensiveTerm } = require('./identity');

const GIF_STYLES = Object.freeze({
    hug: { label: 'Hug', queries: ['hug', 'group hug'] },
    cheer: { label: 'Cheer / hype', queries: ['cheering', 'lets go', 'hype'] },
    clap: { label: 'Clap', queries: ['applause', 'clapping'] },
    thumbs_up: { label: 'Thumbs up', queries: ['thumbs up', 'nice job'] },
    laugh: { label: 'Wholesome laugh', queries: ['laughing', 'lol'] },
    facepalm: { label: 'Facepalm', queries: ['facepalm'] },
    mind_blown: { label: 'Mind blown', queries: ['mind blown'] },
    mic_drop: { label: 'Mic drop', queries: ['mic drop'], roast: true },
    side_eye: { label: 'Side-eye', queries: ['side eye'], roast: true },
    you_tried: { label: '“You tried”', queries: ['you tried'], roast: true },
    roast: { label: 'Roast', queries: ['roasted', 'burn'], roast: true }
});

const GENTLE_STYLES = ['hug', 'cheer', 'clap', 'thumbs_up', 'laugh'];
const NEUTRAL_STYLES = [...GENTLE_STYLES, 'facepalm', 'mind_blown'];
const SAVAGE_STYLES = [...NEUTRAL_STYLES, 'mic_drop', 'side_eye', 'you_tried', 'roast'];
const GIF_MODE_STYLES = Object.freeze({ gentle: GENTLE_STYLES, neutral: NEUTRAL_STYLES, savage: SAVAGE_STYLES });
const GIF_MODES = Object.freeze(Object.keys(GIF_MODE_STYLES));
const ROAST_STYLES = Object.freeze(Object.keys(GIF_STYLES).filter((id) => GIF_STYLES[id].roast));

// At most one GIF per `every` bot replies in a channel, and one per member per `cooldownMs`.
const GIF_FREQUENCIES = Object.freeze({
    rare: { every: 20, cooldownMs: 10 * 60 * 1000 },
    normal: { every: 8, cooldownMs: 5 * 60 * 1000 },
    often: { every: 4, cooldownMs: 2 * 60 * 1000 }
});
// 'chat' = only channels where ZiGBoT chats freely (dashboard chat channels).
const GIF_CHANNEL_SCOPES = Object.freeze(['chat', 'all']);
const GIF_STYLE_MAX = 30;

// Never part of a search, whatever the AI or an admin writes.
const QUERY_BLOCKLIST = [
    'nsfw', 'nude', 'naked', 'sexy', 'sex', 'sexual', 'porn', 'hentai', 'boob', 'butt', 'thong', 'bikini', 'lingerie', 'twerk', 'kiss',
    'blood', 'gore', 'gun', 'shoot', 'kill', 'dead', 'death', 'suicide', 'knife', 'stab', 'fight', 'punch', 'war', 'bomb',
    'drunk', 'drug', 'weed', 'beer', 'alcohol', 'smoke', 'vape', 'cigarette', 'nazi', 'hitler', 'terror'
];

function defaultGifSettings() {
    return {
        enabled: true,
        channels: 'chat',
        blocked_channel_ids: [],
        custom_style: '',
        modes: {
            gentle: { enabled: true, frequency: 'normal', styles: [...GENTLE_STYLES] },
            neutral: { enabled: true, frequency: 'normal', styles: [...NEUTRAL_STYLES] },
            savage: { enabled: true, frequency: 'normal', styles: [...SAVAGE_STYLES], roast: true }
        }
    };
}

/** Is `text` safe to be part of a GIF search? (block list + profanity/slur filter) */
function queryProblem(text) {
    const lower = String(text || '').toLowerCase();
    const words = lower.split(/[^a-z0-9]+/).filter(Boolean);
    const blocked = QUERY_BLOCKLIST.find((term) => words.some((w) => w === term || (term.length >= 4 && w.startsWith(term))));
    if (blocked) return 'contains a word that is never searched for';
    if (offensiveTerm(lower)) return 'contains profanity or a slur';
    return null;
}

/**
 * A custom persona's GIF style ("pirate", "90s cartoons"): 1-3 words,
 * letters/numbers/spaces, at most 30 characters, and it passes the filters.
 * Returns { value, error } — value '' means "no style".
 */
function validateGifStyle(raw) {
    if (raw === undefined || raw === null) return { value: '', error: null };
    if (typeof raw !== 'string') return { value: '', error: 'GIF style must be text.' };
    const value = raw.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
    if (!value) return { value: '', error: null };
    if (value.length > GIF_STYLE_MAX) return { value, error: `GIF style can be at most ${GIF_STYLE_MAX} characters.` };
    if (!/^[\p{L}\p{N}' ]+$/u.test(value)) return { value, error: 'GIF style can only use letters, numbers and spaces.' };
    if (value.split(' ').length > 3) return { value, error: 'GIF style can be at most 3 words.' };
    const problem = queryProblem(value);
    if (problem) return { value, error: `That GIF style ${problem}.` };
    return { value, error: null };
}

function cleanMode(raw, mode, fallback, errors) {
    const allowed = GIF_MODE_STYLES[mode];
    const out = { ...fallback, styles: [...fallback.styles] };
    if (raw === undefined) return out;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        if (errors) errors.push(`${mode}: must be an object.`);
        return out;
    }
    if (raw.enabled !== undefined) {
        if (typeof raw.enabled === 'boolean') out.enabled = raw.enabled;
        else if (errors) errors.push(`${mode}: "enabled" must be true or false.`);
    }
    if (raw.frequency !== undefined) {
        if (Object.hasOwn(GIF_FREQUENCIES, raw.frequency)) out.frequency = raw.frequency;
        else if (errors) errors.push(`${mode}: frequency must be rare, normal or often.`);
    }
    if (raw.styles !== undefined) {
        if (!Array.isArray(raw.styles)) {
            if (errors) errors.push(`${mode}: styles must be a list.`);
        } else {
            const outside = raw.styles.filter((s) => !allowed.includes(s));
            if (outside.length && errors) errors.push(`${mode}: ${outside.map(String).join(', ')} ${outside.length === 1 ? 'is' : 'are'} not allowed in this mode.`);
            out.styles = allowed.filter((s) => raw.styles.includes(s));
        }
    }
    if (mode === 'savage') {
        if (raw.roast !== undefined) {
            if (typeof raw.roast === 'boolean') out.roast = raw.roast;
            else if (errors) errors.push('savage: "roast" must be true or false.');
        }
    } else {
        // Gentle and Neutral can never roast: any stored or submitted flag is dropped.
        if (raw.roast === true && errors) errors.push(`${mode}: roast GIFs are only available in Savage mode.`);
        delete out.roast;
    }
    return out;
}

function readGifSettings(raw, { errors = null, channelIds = null } = {}) {
    const base = defaultGifSettings();
    if (raw === undefined || raw === null) return base;
    if (typeof raw !== 'object' || Array.isArray(raw)) {
        if (errors) errors.push('GIF settings must be an object.');
        return base;
    }
    const out = { ...base };
    if (raw.enabled !== undefined) {
        if (typeof raw.enabled === 'boolean') out.enabled = raw.enabled;
        else if (errors) errors.push('"enabled" must be true or false.');
    }
    if (raw.channels !== undefined) {
        if (GIF_CHANNEL_SCOPES.includes(raw.channels)) out.channels = raw.channels;
        else if (errors) errors.push('Channels must be "chat" or "all".');
    }
    if (raw.blocked_channel_ids !== undefined) {
        const ids = Array.isArray(raw.blocked_channel_ids) ? raw.blocked_channel_ids.map(String) : null;
        if (!ids) {
            if (errors) errors.push('Blocked channels must be a list.');
        } else {
            const valid = ids.filter((id) => /^\d{17,20}$/.test(id) && (!channelIds || channelIds.has(id)));
            if (valid.length !== ids.length && errors) errors.push('Some blocked GIF channels are not channels of this server.');
            out.blocked_channel_ids = [...new Set(valid)].slice(0, 100);
        }
    }
    const style = validateGifStyle(raw.custom_style);
    if (style.error) {
        if (errors) errors.push(style.error);
        out.custom_style = '';
    } else {
        out.custom_style = style.value;
    }
    const modes = raw.modes && typeof raw.modes === 'object' && !Array.isArray(raw.modes) ? raw.modes : {};
    if (raw.modes !== undefined && modes !== raw.modes && errors) errors.push('Modes must be an object.');
    out.modes = Object.fromEntries(GIF_MODES.map((mode) => [mode, cleanMode(modes[mode], mode, base.modes[mode], errors)]));
    return out;
}

/** Dashboard save: { value, error } (error is one readable message or null). */
function validateGifSettings(raw, { channelIds = null } = {}) {
    const errors = [];
    const value = readGifSettings(raw, { errors, channelIds });
    return { value, error: errors.length ? errors.join(' ') : null };
}

/** Bot load: whatever is stored becomes safe settings (invalid parts fall back). */
function sanitizeGifSettings(raw) {
    return readGifSettings(raw);
}

/**
 * The GIF rules for one reply.
 *  tone: the tone resolved for this member (gentle / neutral / savage)
 *  isMinor: under-18 role → Gentle rules, whatever the tone or persona
 *  customPersona: a Premium custom persona is active for this reply
 * Returns { mode, enabled, frequency, styles, roastAllowed, customStyle, inferStyle }.
 */
function resolveGifRules({ settings, tone, isMinor = false, customPersona = false }) {
    const gifs = settings && settings.modes ? settings : defaultGifSettings();
    const mode = isMinor ? 'gentle' : GIF_MODES.includes(tone) ? tone : 'gentle';
    const modeSettings = gifs.modes[mode] || defaultGifSettings().modes[mode];
    const roastAllowed = mode === 'savage' && modeSettings.roast !== false;
    const styles = GIF_MODE_STYLES[mode].filter((s) => modeSettings.styles.includes(s) && (roastAllowed || !GIF_STYLES[s].roast));
    const usesCustom = Boolean(customPersona) && !isMinor;
    const custom = usesCustom ? validateGifStyle(gifs.custom_style) : { value: '' };
    const customStyle = custom.error ? '' : custom.value;
    return {
        mode,
        enabled: Boolean(gifs.enabled) && modeSettings.enabled !== false && styles.length > 0,
        frequency: Object.hasOwn(GIF_FREQUENCIES, modeSettings.frequency) ? modeSettings.frequency : 'normal',
        styles,
        roastAllowed,
        customStyle: customStyle || null,
        inferStyle: usesCustom && !customStyle
    };
}

/**
 * The search query for a style, plus the persona style when it passes the
 * filters. Returns null if the result would not be safe to search.
 */
function buildGifQuery(styleId, { customStyle = null, rng = Math.random } = {}) {
    const style = GIF_STYLES[styleId];
    if (!style) return null;
    const base = style.queries[Math.min(style.queries.length - 1, Math.floor(rng() * style.queries.length))];
    const extra = customStyle ? validateGifStyle(customStyle) : { value: '' };
    const query = extra.error || !extra.value ? base : `${base} ${extra.value}`;
    return queryProblem(query) ? null : query;
}

module.exports = {
    GIF_STYLES,
    GIF_MODE_STYLES,
    GIF_MODES,
    ROAST_STYLES,
    GIF_FREQUENCIES,
    GIF_CHANNEL_SCOPES,
    GIF_STYLE_MAX,
    defaultGifSettings,
    gifQueryProblem: queryProblem,
    validateGifStyle,
    validateGifSettings,
    sanitizeGifSettings,
    resolveGifRules,
    buildGifQuery
};
