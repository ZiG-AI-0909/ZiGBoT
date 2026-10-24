/**
 * Exports the public command catalog for the dashboard's /commands page.
 *
 *   npm run export-commands   ->  dashboard/data/commands.json
 *
 * Single source of truth: names, descriptions, subcommands, options and
 * default permissions come from the REAL definitions in src/slash.js. The
 * dashboard cannot import src/slash.js (it is a self-contained Next.js app
 * without discord.js), so the result is committed as JSON and
 * test/commandsCatalog.test.js fails whenever the JSON is out of sync.
 *
 * This file only adds what Discord's definitions cannot express:
 * categories, example values, short plain explanations, and the
 * "Talk to ZiGBoT" mention examples (each tied to the code path that handles
 * it, and checked by the test). Owner-only YouTube commands are excluded.
 */
const fs = require('node:fs');
const path = require('node:path');
const { PermissionFlagsBits } = require('discord.js');
const { buildDefinitions, YOUTUBE_COMMANDS } = require('../src/slash');

const OUTPUT = path.join(__dirname, '..', 'dashboard', 'data', 'commands.json');

const CATEGORIES = [
    { id: 'memory', name: 'Memory', commands: ['memory', 'summarychannels'] },
    { id: 'music', name: 'Music & voice', commands: ['play', 'search', 'pause', 'resume', 'skip', 'stop', 'queue', 'nowplaying', 'volume', 'shuffle', 'loop', 'remove', 'clearqueue', 'join', 'leave'] },
    { id: 'moderation', name: 'Moderation', commands: ['kick', 'ban', 'reputation'] },
    { id: 'setup', name: 'Server setup', commands: ['setup'] },
    { id: 'help', name: 'Help', commands: ['help'] }
];

// Example values, keyed "command.option" or "command subcommand.option".
// Options without one fall back to a placeholder by type (or the first
// choice), so a new option always still gets an example.
const EXAMPLE_VALUES = {
    'play.song': 'Believer by Imagine Dragons',
    'search.song': 'lofi beats',
    'volume.level': '60',
    'remove.position': '2',
    'memory remember.text': 'my favourite game is chess',
    'memory search.query': 'chess',
    'memory correct.id': '3',
    'memory correct.text': 'my favourite game is Go',
    'memory forget.id': '3',
    'memory share.id': '3',
    'memory share.shared': 'True',
    'memory summaries.state': 'on',
    'summarychannels add.channel': '#general',
    'summarychannels remove.channel': '#general'
};

// Plain explanations shown under a command, with a link to the privacy page.
const ABOUT = {
    memory: 'Everything ZiGBoT remembers about you in a server, in your hands: see it, search it, save or correct a note, share one with the server, export it, delete it, or turn memory off. Replies are private. Conversation summaries are off unless you opt in.',
    summarychannels: 'Admins choose up to 10 channels where members who opted in to conversation summaries may also have their own messages summarised. A member is only read in a channel they were shown when they opted in. Age-restricted channels and threads are never allowed.'
};

// Subcommands that are admin-only even though the parent command is not
// (Discord cannot express per-subcommand permissions; ZiGBoT checks them).
const SUBCOMMAND_ADMIN_NOTES = {
    'memory diagnostics': 'Members can see /memory, but this subcommand is refused unless you are the server owner or an admin.'
};

// "Talk to ZiGBoT": mention examples, each tied to the code that handles it.
//   kind 'chat'              -> normal AI reply (src/index.js chat path)
//   kind 'action'            -> routed by the intent classifier to a router action
//   kind 'memory-question'   -> deterministic count-only answer (isMemoryQuestion)
//   kind 'reputation-question' -> deterministic record answer (isReputationQuestion)
//   kind 'creator-question'  -> fixed "who made me" answer (isCreatorQuestion)
const TALK = [
    { message: '@ZiGBoT exams are stressing me out, any tips?', kind: 'chat', what: 'Chat about anything. ZiGBoT replies in the personality this server chose.' },
    { message: '@ZiGBoT play Believer by Imagine Dragons', kind: 'action', action: 'play', what: 'Plays a song in your voice channel, when music is on in this server.' },
    { message: '@ZiGBoT what can you do?', kind: 'action', action: 'bot_help', what: 'Lists what ZiGBoT can do.' },
    { message: '@ZiGBoT what do you remember about me?', kind: 'memory-question', what: 'Says how many memories it has saved for you here, as a count only. Use /memory view to see them privately.' },
    { message: "@ZiGBoT what's my reputation?", kind: 'reputation-question', what: 'Shows your recent behaviour record in this server, if the server has it turned on.' },
    { message: '@ZiGBoT who made you?', kind: 'creator-question', what: 'Explains who made ZiGBoT.' }
];

const OPTION_TYPES = { 3: 'text', 4: 'number', 5: 'yes/no', 6: 'member', 7: 'channel', 8: 'role', 10: 'number' };
const PLACEHOLDERS = { 3: (o) => `<${o.name}>`, 4: (o) => String(o.min_value ?? 1), 5: () => 'True', 6: () => '@member', 7: () => '#channel', 8: () => '@role', 10: (o) => String(o.min_value ?? 1) };
const PERMISSION_NAMES = { ManageGuild: 'Manage Server', KickMembers: 'Kick Members', BanMembers: 'Ban Members', Administrator: 'Administrator' };

function permissionName(bits) {
    if (bits === null || bits === undefined) return null;
    const value = BigInt(bits);
    const names = Object.entries(PermissionFlagsBits)
        .filter(([, flag]) => flag !== 0n && (value & flag) === flag)
        .map(([key]) => PERMISSION_NAMES[key] || key.replace(/([a-z])([A-Z])/g, '$1 $2'));
    return names.join(', ') || null;
}

function exampleValue(key, option) {
    if (EXAMPLE_VALUES[key] !== undefined) return EXAMPLE_VALUES[key];
    if (Array.isArray(option.choices) && option.choices.length > 0) return option.choices[0].name;
    return (PLACEHOLDERS[option.type] || ((o) => `<${o.name}>`))(option);
}

function mapOptions(prefix, options = []) {
    return options.map((option) => ({
        name: option.name,
        type: OPTION_TYPES[option.type] || 'text',
        required: option.required === true,
        description: option.description,
        ...(Array.isArray(option.choices) && option.choices.length > 0 ? { choices: option.choices.map((choice) => choice.name) } : {}),
        ...(option.min_value !== undefined ? { min: option.min_value } : {}),
        ...(option.max_value !== undefined ? { max: option.max_value } : {}),
        ...(option.max_length !== undefined ? { maxLength: option.max_length } : {})
    }));
}

// "/name [sub] opt:value ..." using required options plus optional ones that
// have an explicit example value.
function buildExample(command, sub, options) {
    const prefix = sub ? `${command} ${sub}` : command;
    const parts = [`/${prefix}`];
    for (const option of options) {
        const key = `${prefix}.${option.name}`;
        if (option.required || EXAMPLE_VALUES[key] !== undefined) parts.push(`${option.name}:${exampleValue(key, option)}`);
    }
    return parts.join(' ');
}

function buildCatalog() {
    const definitions = buildDefinitions().filter((definition) => !YOUTUBE_COMMANDS.has(definition.name));
    const byName = new Map(definitions.map((definition) => [definition.name, definition]));
    const categorised = new Set(CATEGORIES.flatMap((category) => category.commands));
    const uncategorised = definitions.map((d) => d.name).filter((name) => !categorised.has(name));
    if (uncategorised.length > 0) {
        throw new Error(`Commands without a category in scripts/export-commands.js: ${uncategorised.join(', ')}`);
    }

    const categories = CATEGORIES.map((category) => ({
        id: category.id,
        name: category.name,
        commands: category.commands.filter((name) => byName.has(name)).map((name) => {
            const definition = byName.get(name);
            const permission = permissionName(definition.default_member_permissions);
            const subcommands = (definition.options || []).filter((option) => option.type === 1);
            const topOptions = (definition.options || []).filter((option) => option.type !== 1);
            const entry = {
                name,
                description: definition.description,
                audience: permission ? 'admin' : 'everyone',
                permission
            };
            if (ABOUT[name]) entry.about = ABOUT[name];
            if (ABOUT[name]) entry.privacyLink = true;
            if (subcommands.length > 0) {
                entry.subcommands = subcommands.map((sub) => {
                    const options = sub.options || [];
                    const note = SUBCOMMAND_ADMIN_NOTES[`${name} ${sub.name}`];
                    return {
                        name: sub.name,
                        description: sub.description,
                        audience: permission || note ? 'admin' : 'everyone',
                        ...(note ? { note } : {}),
                        options: mapOptions(`${name} ${sub.name}`, options),
                        example: buildExample(name, sub.name, options)
                    };
                });
            } else {
                entry.options = mapOptions(name, topOptions);
                entry.example = buildExample(name, null, topOptions);
            }
            return entry;
        })
    })).filter((category) => category.commands.length > 0);

    return {
        generatedBy: 'scripts/export-commands.js (npm run export-commands) from src/slash.js — do not edit by hand',
        talk: TALK.map(({ message, what }) => ({ message, what })),
        categories
    };
}

if (require.main === module) {
    const catalog = buildCatalog();
    fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
    fs.writeFileSync(OUTPUT, `${JSON.stringify(catalog, null, 2)}\n`);
    const count = catalog.categories.reduce((sum, category) => sum + category.commands.length, 0);
    console.log(`Wrote ${path.relative(process.cwd(), OUTPUT)}: ${count} commands in ${catalog.categories.length} categories, ${catalog.talk.length} mention examples.`);
}

module.exports = { buildCatalog, TALK, CATEGORIES, OUTPUT };
