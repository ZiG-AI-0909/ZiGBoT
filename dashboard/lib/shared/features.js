/**
 * Optional features (docs/ZIGBOT_FEATURE_MATRIX.md, sections B-M), stored in
 * ONE jsonb column: zb_guild_configs.feature_settings = { <section>: {...} }.
 *
 * Everything here is OFF by default: a server that changes nothing behaves
 * exactly as before. Each section is a list of field descriptors, used by
 *  - validateFeatureSettings(): dashboard saves (ids checked against the
 *    server's live channels and roles),
 *  - sanitizeFeatureSettings(): the bot reading whatever is stored,
 *  - the GuildEditor "Features" tab, which renders the same descriptors.
 * CommonJS, shared by the bot, the dashboard and the tests.
 *
 * Field types: bool, int {min,max}, text {max}, enum {options}, channel,
 * role, channels {max}, roles {max}, list {max, item(value) -> clean|null}.
 */
const SNOWFLAKE = /^\d{17,20}$/;

const bool = (key, label, extra = {}) => ({ key, label, type: 'bool', default: false, ...extra });
const int = (key, label, def, min, max, extra = {}) => ({ key, label, type: 'int', default: def, min, max, ...extra });
const text = (key, label, def, max, extra = {}) => ({ key, label, type: 'text', default: def, max, ...extra });
const channel = (key, label, extra = {}) => ({ key, label, type: 'channel', default: null, ...extra });
const role = (key, label, extra = {}) => ({ key, label, type: 'role', default: null, ...extra });
const roles = (key, label, max = 10, extra = {}) => ({ key, label, type: 'roles', default: [], max, ...extra });
const channels = (key, label, max = 20, extra = {}) => ({ key, label, type: 'channels', default: [], max, ...extra });
const pick = (key, label, def, options, extra = {}) => ({ key, label, type: 'enum', default: def, options, ...extra });

const list = (key, label, max, itemFields, extra = {}) => ({ key, label, type: 'list', default: [], max, itemFields, ...extra });

const TIMEZONES = ['Asia/Kolkata', 'UTC', 'Europe/London', 'Europe/Berlin', 'America/New_York', 'America/Chicago', 'America/Los_Angeles', 'Asia/Dubai', 'Asia/Singapore', 'Asia/Tokyo', 'Australia/Sydney'];

const FEATURE_SECTIONS = {
    community: {
        label: 'Community',
        fields: [
            bool('welcome_enabled', 'Welcome new members'),
            channel('welcome_channel_id', 'Welcome channel'),
            text('welcome_message', 'Welcome message', 'Welcome {user} to {server}! You are member #{memberCount}.', 1000, { help: 'Placeholders: {user} {server} {memberCount}' }),
            bool('welcome_image_enabled', 'Attach a welcome image card'),
            bool('goodbye_enabled', 'Say goodbye when a member leaves'),
            channel('goodbye_channel_id', 'Goodbye channel'),
            text('goodbye_message', 'Goodbye message', '{user} left {server}. We are now {memberCount} members.', 1000, { help: 'Placeholders: {user} {server} {memberCount}' }),
            bool('autorole_enabled', 'Give new members a role (bots are skipped)'),
            roles('autorole_role_ids', 'Roles for new members', 5),
            bool('milestones_enabled', 'Celebrate member milestones'),
            int('milestone_every', 'Celebrate every N members', 100, 10, 100000),
            bool('birthdays_enabled', 'Birthday announcements'),
            channel('birthday_channel_id', 'Birthday channel'),
            pick('timezone', 'Server timezone', 'Asia/Kolkata', TIMEZONES),
            bool('member_count_enabled', 'Show the member count in a voice channel name'),
            channel('member_count_channel_id', 'Member count voice channel'),
            text('member_count_template', 'Channel name', 'Members: {count}', 60, { help: 'Placeholder: {count}. Updated at most once every 10 minutes.' }),
            bool('starboard_enabled', 'Starboard'),
            channel('starboard_channel_id', 'Starboard channel'),
            int('starboard_threshold', 'Stars needed', 3, 1, 50),
            bool('suggestions_enabled', 'Suggestions (/suggest)'),
            channel('suggestions_channel_id', 'Suggestions channel'),
            bool('role_panels_enabled', 'Self-assign role panels (/roles)'),
            bool('polls_enabled', 'Polls (/community poll)'),
            bool('announcements_enabled', 'Staff announcements and reminders (/community announce, remind)')
        ]
    },
    automation: {
        label: 'Automation',
        fields: [
            bool('scheduled_messages_enabled', 'Scheduled and automatic announcements'),
            list('scheduled_messages', 'Scheduled messages', 10, [
                channel('channel_id', 'Channel'),
                text('message', 'Message', '', 1500, { help: 'Placeholders: {server} {memberCount}' }),
                int('every_hours', 'Every how many hours', 24, 1, 720)
            ], { itemCheck: (e) => (!e.channel_id ? 'pick a channel' : !e.message.trim() ? 'write the message' : null) }),
            bool('auto_purge_enabled', 'Auto-purge old messages'),
            list('auto_purge', 'Auto-purge channels', 5, [
                channel('channel_id', 'Channel'),
                int('older_than_hours', 'Delete messages older than (hours)', 24, 1, 336, { help: 'Discord only bulk-deletes messages younger than 14 days. Pinned messages are kept.' }),
                int('every_hours', 'Run every how many hours', 6, 1, 168)
            ], { itemCheck: (e) => (!e.channel_id ? 'pick a channel' : null) }),
            bool('rules_enabled', 'Trigger rules (WHEN … IF … THEN …)'),
            list('rules', 'Rules', 25, [
                pick('when', 'When', 'join', ['join', 'message', 'reaction']),
                text('keyword', 'Message contains (for "message")', '', 100),
                text('emoji', 'Reaction emoji (for "reaction")', '', 64),
                role('if_role_id', 'Only if the member has role'),
                channel('if_channel_id', 'Only in channel'),
                pick('then', 'Then', 'send_message', ['send_message', 'add_role', 'remove_role']),
                text('message', 'Message to send', '', 1500, { help: 'Placeholders: {user} {server} {memberCount}' }),
                channel('channel_id', 'Send in channel (default: where it happened)'),
                role('role_id', 'Role to add or remove')
            ], {
                itemCheck: (e) => {
                    if (e.when === 'message' && !e.keyword.trim()) return 'a message rule needs a keyword';
                    if (e.when === 'reaction' && !e.emoji.trim()) return 'a reaction rule needs an emoji';
                    if (e.then === 'send_message' && !e.message.trim()) return 'write the message to send';
                    if (e.then === 'send_message' && e.when === 'join' && !e.channel_id) return 'pick the channel to send in';
                    if (e.then !== 'send_message' && !e.role_id) return 'pick the role';
                    return null;
                }
            }),
            bool('events_enabled', 'Discord scheduled events (/automation event)'),
            bool('reminders_enabled', 'Personal reminders (/automation remind)')
        ]
    }
};

function defaultSection(name) {
    const out = {};
    for (const field of FEATURE_SECTIONS[name].fields) out[field.key] = Array.isArray(field.default) ? [...field.default] : field.default;
    return out;
}

function defaultFeatureSettings() {
    const out = {};
    for (const name of Object.keys(FEATURE_SECTIONS)) out[name] = defaultSection(name);
    return out;
}

const cleanText = (value, max) => String(value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').slice(0, max);

/**
 * One field. ids: { channelIds, roleIds } as Sets, or null to accept any
 * well-formed id (the bot side, which re-checks against Discord when it acts).
 * Returns { value } or { error }.
 */
function readField(field, raw, ids, guildId) {
    if (raw === undefined || raw === null) return { value: Array.isArray(field.default) ? [...field.default] : field.default };
    const known = (id, set) => SNOWFLAKE.test(id) && id !== String(guildId || '') && (!set || set.has(id));
    switch (field.type) {
        case 'bool':
            return typeof raw === 'boolean' ? { value: raw } : { error: 'Must be on or off.' };
        case 'int': {
            const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
            if (!Number.isInteger(n) || n < field.min || n > field.max) return { error: `Must be a whole number from ${field.min} to ${field.max}.` };
            return { value: n };
        }
        case 'text':
            if (typeof raw !== 'string') return { error: 'Must be text.' };
            if (raw.length > field.max) return { error: `At most ${field.max} characters.` };
            return { value: cleanText(raw, field.max) };
        case 'enum':
            return field.options.includes(raw) ? { value: raw } : { error: `Pick one of: ${field.options.join(', ')}.` };
        case 'channel':
        case 'role': {
            if (raw === '') return { value: null };
            const id = String(raw);
            return known(id, field.type === 'channel' ? ids?.channelIds : ids?.roleIds) ? { value: id } : { error: `That ${field.type} is not in this server.` };
        }
        case 'channels':
        case 'roles': {
            if (!Array.isArray(raw)) return { error: 'Must be a list.' };
            if (raw.length > field.max) return { error: `At most ${field.max}.` };
            const set = field.type === 'channels' ? ids?.channelIds : ids?.roleIds;
            const list = [...new Set(raw.map(String))];
            if (!list.every((id) => known(id, set))) return { error: `One of those ${field.type} is not in this server.` };
            return { value: list };
        }
        case 'list': {
            // Each entry is an object checked field by field (field.itemFields),
            // then by field.itemCheck(entry) for rules that span fields.
            if (!Array.isArray(raw)) return { error: 'Must be a list.' };
            if (raw.length > field.max) return { error: `At most ${field.max} entries.` };
            const out = [];
            for (let i = 0; i < raw.length; i += 1) {
                const given = raw[i];
                if (!given || typeof given !== 'object' || Array.isArray(given)) return { error: `Entry ${i + 1} is not valid.` };
                const entry = {};
                for (const sub of field.itemFields) {
                    const result = readField(sub, given[sub.key], ids, guildId);
                    if (result.error) return { error: `Entry ${i + 1}, ${sub.label}: ${result.error}` };
                    entry[sub.key] = result.value;
                }
                const problem = field.itemCheck ? field.itemCheck(entry) : null;
                if (problem) return { error: `Entry ${i + 1}: ${problem}` };
                out.push(entry);
            }
            return { value: out };
        }
        default:
            return { error: 'Unknown setting.' };
    }
}

/** Dashboard save. Returns { value, errors } with errors keyed "section.key". */
function validateFeatureSettings(input, { channelIds = null, roleIds = null, guildId = null } = {}) {
    const errors = {};
    const value = defaultFeatureSettings();
    if (input === undefined || input === null) return { value, errors };
    if (typeof input !== 'object' || Array.isArray(input)) return { value, errors: { feature_settings: 'Must be an object.' } };
    for (const [name, section] of Object.entries(FEATURE_SECTIONS)) {
        const given = input[name];
        if (given === undefined || given === null) continue;
        if (typeof given !== 'object' || Array.isArray(given)) {
            errors[name] = 'Must be an object.';
            continue;
        }
        for (const field of section.fields) {
            const result = readField(field, given[field.key], { channelIds, roleIds }, guildId);
            if (result.error) errors[`${name}.${field.key}`] = result.error;
            else value[name][field.key] = result.value;
        }
        for (const check of section.checks || []) {
            const problem = check(value[name]);
            if (problem) errors[`${name}.${problem.key}`] = problem.error;
        }
    }
    return { value, errors };
}

/** Bot side: anything invalid falls back to its (off) default. Never throws. */
function sanitizeFeatureSettings(raw, { guildId = null } = {}) {
    const value = defaultFeatureSettings();
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return value;
    for (const [name, section] of Object.entries(FEATURE_SECTIONS)) {
        const given = raw[name];
        if (!given || typeof given !== 'object' || Array.isArray(given)) continue;
        for (const field of section.fields) {
            const result = readField(field, given[field.key], null, guildId);
            if (!result.error) value[name][field.key] = result.value;
        }
    }
    return value;
}

// A feature needs its channel/roles before it can be switched on.
const needs = (flag, key, error) => (s) => (s[flag] && (Array.isArray(s[key]) ? s[key].length === 0 : !s[key]) ? { key, error } : null);
FEATURE_SECTIONS.community.checks = [
    needs('welcome_enabled', 'welcome_channel_id', 'Pick a welcome channel.'),
    needs('goodbye_enabled', 'goodbye_channel_id', 'Pick a goodbye channel.'),
    needs('autorole_enabled', 'autorole_role_ids', 'Pick at least one role.'),
    needs('birthdays_enabled', 'birthday_channel_id', 'Pick a birthday channel.'),
    needs('member_count_enabled', 'member_count_channel_id', 'Pick a voice channel.'),
    needs('starboard_enabled', 'starboard_channel_id', 'Pick a starboard channel.'),
    needs('suggestions_enabled', 'suggestions_channel_id', 'Pick a suggestions channel.'),
    (s) => (s.milestones_enabled && !s.welcome_channel_id ? { key: 'welcome_channel_id', error: 'Milestones are posted in the welcome channel: pick one.' } : null)
];
FEATURE_SECTIONS.automation.checks = [
    needs('scheduled_messages_enabled', 'scheduled_messages', 'Add at least one scheduled message.'),
    needs('auto_purge_enabled', 'auto_purge', 'Add at least one channel to purge.'),
    needs('rules_enabled', 'rules', 'Add at least one rule.')
];

module.exports = { FEATURE_SECTIONS, TIMEZONES, defaultFeatureSettings, validateFeatureSettings, sanitizeFeatureSettings, featureFieldHelpers: { bool, int, text, channel, role, roles, channels, pick, list, needs } };
