/**
 * Custom Bot Identity (Premium): a per-server nickname, avatar and bio for
 * the existing ZiGBoT bot, set through Discord's Modify Current Member
 * endpoint (PATCH /guilds/{id}/members/@me). Shared by the dashboard
 * (save-time validation) and the bot (sync and revert). CommonJS, like the
 * rest of lib/shared.
 *
 * Rules that keep it honest:
 *  - Discord's APP tag always shows; nothing here tries to make the bot look
 *    like a human user or like Discord, Discord staff, ZiGBoT staff, or
 *    another well-known bot.
 *  - Only servers that saved an identity are ever touched. A server that is
 *    not Premium (or is blocked) is reverted to the default ZiGBoT profile.
 *  - Avatars are applied only after the bot owner approves them.
 *
 * The slur list below exists only to block those words from names and bios.
 */
const { PROFANITY_TERMS, EXCLUDED_TERMS } = require('./profanity');

const IDENTITY_LIMITS = Object.freeze({
    nickMin: 1,
    nickMax: 32, // Discord: nicknames are 1-32 characters
    bioMax: 190,
    bioMaxLines: 4,
    imageMaxBytes: 2 * 1024 * 1024,
    imageMinPx: 128,
    imageMaxPx: 4096,
    avatarPx: 512,
    changesPerHour: 5,
    changesPerDay: 20,
    lapsedImageDays: 30
});

const IDENTITY_BUCKET = 'zb-identity';
const IDENTITY_IMAGE_PATH = /^\d{17,20}\/[0-9a-f]{64}\.png$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Storage path of a processed avatar: <guild_id>/<sha256>.png. */
function identityImagePath(guildId, sha256) {
    const path = `${guildId}/${sha256}.png`;
    if (!IDENTITY_IMAGE_PATH.test(path)) throw new Error('Invalid identity image path');
    return path;
}

// Look-alike characters folded before matching ("D1sc0rd", Cyrillic "о").
const CONFUSABLES = {
    0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b', 9: 'g', '@': 'a', $: 's', '!': 'i', '|': 'l',
    а: 'a', е: 'e', о: 'o', р: 'p', с: 'c', х: 'x', у: 'y', і: 'i', ј: 'j', ѕ: 's', ԁ: 'd', ӏ: 'l', ɡ: 'g',
    α: 'a', ε: 'e', ι: 'i', κ: 'k', ν: 'v', ο: 'o', ρ: 'p', τ: 't', υ: 'u', χ: 'x'
};
// "1" and "|" read as either i or l, so both spellings are checked.
const AMBIGUOUS_L = { 1: 'l', '|': 'l', '!': 'l' };

// Invisible or blank-looking letters that render as nothing.
const BLANK_CHARS = /[ᅟᅠㅤﾠ⠀᠎឴឵]/u;
const FORBIDDEN_CHARS = /[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Cn}\p{Zl}\p{Zp}]/u;
// "Zalgo" stacks, checked on the decomposed text: real scripts (Vietnamese,
// Devanagari) stack at most two marks there.
const MARK_PILE = /\p{M}{3,}/u;
const hasMarkPile = (text) => MARK_PILE.test(text.normalize('NFD'));

const STAFF_WORDS = ['staff', 'team', 'support', 'admin', 'administrator', 'official', 'dev', 'developer', 'owner', 'mod', 'moderator', 'helpdesk', 'security', 'safety'];
// Whole words (after folding) that claim an official or system account.
const OFFICIAL_WORDS = ['official', 'staff', 'system', 'verified', 'automod'];
const OFFICIAL_PHRASES = ['trust and safety', 'trust safety', 'support team', 'safety team', 'admin team', 'mod team', 'moderation team'];
// Well-known bots: distinctive names match anywhere, short or common ones only as a whole word.
const BOT_NAMES_ANYWHERE = ['mee6', 'carlbot', 'probot', 'dankmemer', 'midjourney', 'tickettool', 'jockiemusic', 'statbot', 'disboard', 'dynobot', 'yagpdb', 'loritta', 'nightbot', 'streamelements', 'chatgpt', 'openai', 'owobot', 'poketwo', 'karuta', 'fredboat', 'mudae'];
const BOT_NAMES_WORD = ['dyno', 'arcane', 'tatsu', 'rythm', 'groovy', 'hydra', 'wick', 'sesh'];
const SLUR_TERMS = ['nigger', 'nigga', 'faggot', 'fag', 'retard', 'tranny', 'chink', 'spic', 'kike', 'paki', 'chamar', 'bhangi', 'chakka'];
// Stems that are blocked even when hidden inside other letters ("xXfuckXx").
const HARD_STEMS = ['fuck', 'shit', 'bitch', 'cunt', 'nigg', 'fagg', 'tranny', 'retard', 'chutiy', 'madarchod', 'maderchod', 'behenchod', 'bhosd', 'bsdk'];

function fold(text, map = CONFUSABLES) {
    const base = String(text || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
    return [...base].map((ch) => (Object.prototype.hasOwnProperty.call(map, ch) ? map[ch] : ch)).join('');
}

// Every spelling we check: letters/digits only ("compact") and space-separated words.
function variants(text) {
    const folded = [fold(text), fold(text, { ...CONFUSABLES, ...AMBIGUOUS_L })];
    const compact = new Set();
    const spaced = new Set();
    for (const f of folded) {
        const c = f.replace(/[^a-z0-9]/g, '');
        compact.add(c);
        compact.add(c.replace(/rn/g, 'm').replace(/vv/g, 'w'));
        spaced.add(` ${f.replace(/[^a-z0-9]+/g, ' ').trim()} `);
    }
    return { compact: [...compact], spaced: [...spaced] };
}

const toWords = (term) => ` ${fold(term).replace(/[^a-z0-9]+/g, ' ').trim()} `;
const hasWord = (v, term) => v.spaced.some((s) => s.includes(toWords(term)));
const hasAnywhere = (v, stem) => v.compact.some((c) => c.includes(stem));

function offensiveTerm(text) {
    const v = variants(text);
    for (const stem of HARD_STEMS) if (hasAnywhere(v, stem)) return stem;
    for (const term of [...SLUR_TERMS, ...EXCLUDED_TERMS, ...PROFANITY_TERMS]) if (hasWord(v, term)) return term;
    return null;
}

/** Why `text` impersonates Discord, its staff, ZiGBoT staff or another bot; null if it doesn't. */
function impersonationProblem(text) {
    const v = variants(text);
    if (hasAnywhere(v, 'discord') || hasAnywhere(v, 'clyde')) return 'Names can’t contain “Discord” or “Clyde”.';
    if (v.compact.some((c) => c === 'everyone' || c === 'here')) return 'That name is reserved by Discord.';
    if (hasAnywhere(v, 'zigbot') && STAFF_WORDS.some((w) => hasAnywhere(v, w))) return 'Names can’t claim to be ZiGBoT staff or support.';
    if (OFFICIAL_WORDS.some((w) => hasWord(v, w)) || OFFICIAL_PHRASES.some((p) => hasWord(v, p)) || hasAnywhere(v, 'trustandsafety') || hasAnywhere(v, 'automod')) {
        return 'Names can’t claim to be an official, staff or system account.';
    }
    if (BOT_NAMES_ANYWHERE.some((n) => hasAnywhere(v, n)) || BOT_NAMES_WORD.some((n) => hasWord(v, n))) return 'Names can’t copy another well-known bot.';
    return null;
}

/** NFC, every whitespace run becomes one space, trimmed. */
function normalizeName(raw) {
    return String(raw ?? '').normalize('NFC').replace(/\s+/gu, ' ').trim();
}

/**
 * Validate a bot nickname. Empty means "keep the name ZiGBoT" (value null).
 * Returns { value, error } — error is a message for the admin, or null.
 */
function validateIdentityName(raw) {
    if (raw !== undefined && raw !== null && typeof raw !== 'string') return { value: null, error: 'Name must be text.' };
    const value = normalizeName(raw);
    if (!value) return { value: null, error: null };
    if (value.length > IDENTITY_LIMITS.nickMax) return { value, error: `Names can be at most ${IDENTITY_LIMITS.nickMax} characters.` };
    if (FORBIDDEN_CHARS.test(value) || BLANK_CHARS.test(value) || hasMarkPile(value)) return { value, error: 'Names can’t contain invisible, control or stacked characters.' };
    if (!/[\p{L}\p{N}]/u.test(value)) return { value, error: 'Names need at least one letter or number.' };
    if (/[@#:]|```/.test(value)) return { value, error: 'Names can’t contain @, #, : or ```.' };
    const impersonation = impersonationProblem(value);
    if (impersonation) return { value, error: impersonation };
    if (offensiveTerm(value)) return { value, error: 'That name isn’t allowed. Please pick something without profanity or slurs.' };
    return { value, error: null };
}

/** Validate the bot's server bio. Empty means no bio (value null). */
function validateIdentityBio(raw) {
    if (raw !== undefined && raw !== null && typeof raw !== 'string') return { value: null, error: 'Bio must be text.' };
    const lines = String(raw ?? '').normalize('NFC').replace(/\r\n?/g, '\n').split('\n').map((line) => line.replace(/[^\S\n]+/gu, ' ').trim());
    const value = lines.join('\n').replace(/\n{2,}/g, '\n').trim();
    if (!value) return { value: null, error: null };
    if (value.length > IDENTITY_LIMITS.bioMax) return { value, error: `Bios can be at most ${IDENTITY_LIMITS.bioMax} characters.` };
    if (value.split('\n').length > IDENTITY_LIMITS.bioMaxLines) return { value, error: `Bios can have at most ${IDENTITY_LIMITS.bioMaxLines} lines.` };
    if (FORBIDDEN_CHARS.test(value.replace(/\n/g, '')) || BLANK_CHARS.test(value) || hasMarkPile(value)) return { value, error: 'Bios can’t contain invisible, control or stacked characters.' };
    if (/https?:\/\/|www\.|discord(?:app)?\.(?:gg|com)\/|\.gg\//i.test(value)) return { value, error: 'Bios can’t contain links or invites.' };
    if (/<[@#][!&]?\d+>|@everyone|@here/i.test(value)) return { value, error: 'Bios can’t contain mentions.' };
    const v = variants(value);
    if (hasAnywhere(v, 'discordstaff') || hasAnywhere(v, 'officialdiscord') || (hasAnywhere(v, 'zigbot') && ['staff', 'support', 'admin', 'official'].some((w) => hasWord(v, w)))) {
        return { value, error: 'Bios can’t claim to be Discord or ZiGBoT staff.' };
    }
    if (offensiveTerm(value)) return { value, error: 'That bio isn’t allowed. Please remove profanity or slurs.' };
    return { value, error: null };
}

/** The real image type from the file's first bytes (never its name or MIME type). */
function detectImageType(bytes) {
    const b = bytes instanceof Uint8Array ? bytes : null;
    if (!b || b.length < 12) return null;
    const ascii = (start, end) => String.fromCharCode(...b.subarray(start, end));
    if (b[0] === 0x89 && ascii(1, 4) === 'PNG' && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'png';
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
    if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp';
    if (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a') return 'gif';
    return null;
}

const DEFAULT_IDENTITY = Object.freeze({ nick: null, bio: null, avatarSha: null });

/** CUSTOM_IDENTITY_GUILDS: comma-separated server ids (invalid entries ignored). */
function parseIdentityGuilds(value) {
    return [...new Set(String(value || '').split(',').map((id) => id.trim()).filter((id) => /^\d{17,20}$/.test(id)))];
}

/** An empty list means every server; otherwise only the listed ones. */
function identityAllowedInGuild(guildId, guilds) {
    return !Array.isArray(guilds) || guilds.length === 0 || guilds.includes(String(guildId));
}

/**
 * What the bot's profile in this server should be.
 *  - null: leave the server alone (it never saved an identity).
 *  - DEFAULT_IDENTITY: plain ZiGBoT (not Premium, blocked, or not one of
 *    the CUSTOM_IDENTITY_GUILDS).
 *  - otherwise the saved nickname/bio and the APPROVED avatar (a pending
 *    one is never applied).
 */
function identityDesired({ row, premium, blocked, allowed = true }) {
    if (!row) return null;
    if (!premium || blocked || !allowed) return DEFAULT_IDENTITY;
    return {
        nick: row.nick || null,
        bio: row.bio || null,
        avatarSha: SHA256_HEX.test(String(row.avatar_sha256 || '')) ? row.avatar_sha256 : null
    };
}

/** What we last applied to Discord, from the stored row. */
function identityApplied(row) {
    if (!row) return DEFAULT_IDENTITY;
    return { nick: row.applied_nick || null, bio: row.applied_bio || null, avatarSha: row.applied_avatar_sha256 || null };
}

/** The fields that differ: { nick?, bio?, avatarSha? } (empty when nothing to do). */
function identityPatch(desired, applied) {
    if (!desired) return {};
    const current = applied || DEFAULT_IDENTITY;
    const patch = {};
    for (const key of ['nick', 'bio', 'avatarSha']) {
        if ((desired[key] || null) !== (current[key] || null)) patch[key] = desired[key] || null;
    }
    return patch;
}

const isDefaultIdentity = (state) => !state || (!state.nick && !state.bio && !state.avatarSha);

/** May this admin save an identity for this server right now? */
function decideIdentitySave({ enabled, premium, guildBlocked, userBlocked, changesLastHour = 0, changesLastDay = 0 }) {
    if (!enabled) return { allowed: false, status: 404, code: 'identity_disabled', reason: 'Custom bot identity isn’t available yet.' };
    if (guildBlocked) return { allowed: false, status: 403, code: 'identity_blocked', reason: 'Custom bot identity has been turned off for this server. Contact ZiGBoT support if you think this is a mistake.' };
    if (userBlocked) return { allowed: false, status: 403, code: 'identity_blocked', reason: 'Your account can’t change ZiGBoT’s identity. Contact ZiGBoT support if you think this is a mistake.' };
    if (!premium) return { allowed: false, status: 403, code: 'premium_required', reason: 'Custom bot identity is a Premium feature.' };
    if (changesLastHour >= IDENTITY_LIMITS.changesPerHour) return { allowed: false, status: 429, code: 'identity_cooldown', reason: `That’s ${IDENTITY_LIMITS.changesPerHour} changes in the last hour. Please try again later.` };
    if (changesLastDay >= IDENTITY_LIMITS.changesPerDay) return { allowed: false, status: 429, code: 'identity_cooldown', reason: `That’s ${IDENTITY_LIMITS.changesPerDay} changes today. Please try again tomorrow.` };
    return { allowed: true };
}

/** Short reason for Discord's audit log (X-Audit-Log-Reason, max 512). */
function identityAuditReason(kind, detail = '') {
    return `ZiGBoT custom identity: ${kind}${detail ? ` (${detail})` : ''}`.slice(0, 500);
}

module.exports = {
    IDENTITY_LIMITS,
    IDENTITY_BUCKET,
    IDENTITY_IMAGE_PATH,
    identityImagePath,
    DEFAULT_IDENTITY,
    parseIdentityGuilds,
    identityAllowedInGuild,
    validateIdentityName,
    validateIdentityBio,
    detectImageType,
    identityDesired,
    identityApplied,
    identityPatch,
    isDefaultIdentity,
    decideIdentitySave,
    identityAuditReason
};
