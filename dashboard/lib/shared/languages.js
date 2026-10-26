/**
 * Server reply languages: the ONE list the dashboard dropdown, the bot's
 * /setup choices and the config validator all use. Each value must be one
 * that personas.js has a full persona for (languageMode); a test checks it.
 * The stored values are the same strings /setup has always saved.
 */
const SUPPORTED_LANGUAGES = Object.freeze([
    Object.freeze({ value: 'English', label: 'English', icon: '🌍', help: 'English-only replies with international humour.' }),
    Object.freeze({ value: 'Hinglish', label: 'Hinglish', icon: '🇮🇳', help: 'Hindi and English mixed, in Roman letters, with desi humour.' })
]);
const LANGUAGE_VALUES = Object.freeze(SUPPORTED_LANGUAGES.map((l) => l.value));
const DEFAULT_LANGUAGE = 'English';

/**
 * For the editor: a stored value that is not on the list (an old free-text
 * value, the home server's "English-Hinglish mix", or never set) is shown as
 * English and flagged. The bot itself keeps reading the stored value as-is
 * until an admin saves.
 */
function normalizeLanguage(stored) {
    const value = typeof stored === 'string' ? stored.trim() : '';
    if (LANGUAGE_VALUES.includes(value)) return { value, supported: true, stored: value };
    return { value: DEFAULT_LANGUAGE, supported: false, stored: value };
}

module.exports = { SUPPORTED_LANGUAGES, LANGUAGE_VALUES, DEFAULT_LANGUAGE, normalizeLanguage };
