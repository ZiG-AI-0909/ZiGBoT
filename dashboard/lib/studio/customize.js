/**
 * Studio Phase 3: bot customization rules (CommonJS, pure).
 * Everything here ends up in the project's settings.json; nothing changes
 * the bot's Discord application, which only the Developer Portal can do.
 */
const { TEMPLATE_PARTS, settingsFor } = require('./generators/shared');

const STATUSES = ['online', 'idle', 'dnd', 'invisible'];
const ACTIVITY_TYPES = ['Playing', 'Listening', 'Watching', 'Competing'];
const HEX = /^#[0-9a-fA-F]{6}$/;

// Shown in the UI so nobody expects Studio to change these.
const PORTAL_ONLY = Object.freeze([
    { what: 'Bot username', where: 'Developer Portal → Bot → Username' },
    { what: 'Avatar and banner', where: 'Developer Portal → Bot → Icon / Banner' },
    { what: 'About me / description', where: 'Developer Portal → General Information → Description' },
    { what: 'Privileged intents (Server Members, Message Content)', where: 'Developer Portal → Bot → Privileged Gateway Intents' },
    { what: 'Install link and permissions', where: 'Developer Portal → OAuth2 → URL Generator' },
    { what: 'Bot token', where: 'Developer Portal → Bot → Reset Token (then paste it in Studio)' }
]);

function validTimezone(tz) {
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: tz });
        return true;
    } catch {
        return false;
    }
}

const text = (value, max) => String(value ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').slice(0, max + 1);

/** { value } (complete settings) or { errors }. Unknown keys are refused. */
function validateSettings(input, template) {
    const errors = {};
    if (!input || typeof input !== 'object' || Array.isArray(input)) return { errors: { _: 'Settings must be an object.' } };
    const unknown = Object.keys(input).filter((k) => !['embedColor', 'presence', 'timezone', 'messages', 'disabledCommands'].includes(k));
    if (unknown.length) errors._ = `Unknown settings: ${unknown.join(', ')}.`;
    const current = settingsFor({ settings: input });
    if (!HEX.test(current.embedColor)) errors.embedColor = 'Use a colour like #5865F2.';
    const p = current.presence;
    if (!STATUSES.includes(p.status)) errors['presence.status'] = `Pick one of: ${STATUSES.join(', ')}.`;
    if (!ACTIVITY_TYPES.includes(p.activityType)) errors['presence.activityType'] = `Pick one of: ${ACTIVITY_TYPES.join(', ')}.`;
    if (typeof p.activityText !== 'string' || text(p.activityText, 128).length > 128) errors['presence.activityText'] = 'At most 128 characters.';
    if (typeof current.timezone !== 'string' || !validTimezone(current.timezone)) errors.timezone = 'Unknown time zone (use a name like Asia/Kolkata).';
    for (const key of ['welcome', 'goodbye', 'error']) {
        const m = current.messages[key];
        if (typeof m !== 'string' || !m.trim() || text(m, 500).length > 500) errors[`messages.${key}`] = 'Write 1-500 characters.';
        else if (/@(everyone|here)/i.test(m)) errors[`messages.${key}`] = '@everyone and @here are not allowed.';
    }
    const commands = TEMPLATE_PARTS[template]?.commands || [];
    if (!Array.isArray(current.disabledCommands) || current.disabledCommands.some((c) => !commands.includes(c))) errors.disabledCommands = 'Only commands of this template can be switched off.';
    else if (commands.length && current.disabledCommands.length >= commands.length) errors.disabledCommands = 'Keep at least one command on.';
    if (Object.keys(errors).length) return { errors };
    return {
        value: {
            embedColor: current.embedColor.toUpperCase(),
            presence: { status: p.status, activityType: p.activityType, activityText: text(p.activityText, 128).trim() },
            timezone: current.timezone,
            messages: { welcome: current.messages.welcome.trim(), goodbye: current.messages.goodbye.trim(), error: current.messages.error.trim() },
            disabledCommands: [...new Set(current.disabledCommands)]
        }
    };
}

/** The live-preview model the UI renders (same placeholder rules as the generated bot). */
function preview(settings, { botName = 'Bot', serverName = 'My Server', userName = 'NewMember' } = {}) {
    const s = settingsFor({ settings });
    const fill = (m) => m.replaceAll('{user}', `@${userName}`).replaceAll('{server}', serverName);
    return {
        botName,
        statusLabel: { online: 'Online', idle: 'Idle', dnd: 'Do Not Disturb', invisible: 'Invisible' }[s.presence.status] || 'Online',
        activityLine: s.presence.activityText ? `${s.presence.activityType === 'Listening' ? 'Listening to' : s.presence.activityType} ${s.presence.activityText}` : '',
        embedColor: s.embedColor,
        welcome: fill(s.messages.welcome),
        goodbye: fill(s.messages.goodbye).replace(`@${userName}`, userName),
        error: s.messages.error
    };
}

module.exports = { STATUSES, ACTIVITY_TYPES, PORTAL_ONLY, validateSettings, preview, validTimezone };
