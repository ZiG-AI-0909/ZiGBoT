/**
 * Parts shared by the three generators: what each template contains, the
 * customizable settings.json, and the common files (.env.example, README,
 * .gitignore). Pure functions; nothing here runs generated code.
 */
const TEMPLATE_PARTS = {
    blank: { commands: ['ping'], intents: ['Guilds'], env: [], welcome: false, ticketButton: false },
    moderation: { commands: ['ping', 'kick', 'ban', 'timeout', 'purge'], intents: ['Guilds', 'GuildMembers'], env: [], welcome: false, ticketButton: false },
    community: {
        commands: ['ping', 'poll', 'serverinfo'], intents: ['Guilds', 'GuildMembers'], welcome: true, ticketButton: false,
        env: [{ name: 'WELCOME_CHANNEL_ID', key: 'welcomeChannelId', note: 'Channel id for welcome and goodbye messages (optional).' }]
    },
    'ai-assistant': {
        commands: ['ping', 'ask'], intents: ['Guilds'], welcome: false, ticketButton: false,
        env: [
            { name: 'AI_API_KEY', key: 'aiApiKey', note: 'Key for an OpenAI-compatible API. Keep it secret.' },
            { name: 'AI_BASE_URL', key: 'aiBaseUrl', default: 'https://api.openai.com/v1', note: 'Base URL of the OpenAI-compatible API.' },
            { name: 'AI_MODEL', key: 'aiModel', default: 'gpt-4o-mini', note: 'Model name.' }
        ]
    },
    'ticket-support': {
        commands: ['ping', 'ticketpanel', 'close'], intents: ['Guilds'], welcome: false, ticketButton: true,
        env: [
            { name: 'TICKET_CATEGORY_ID', key: 'ticketCategoryId', note: 'Category for ticket channels (optional).' },
            { name: 'TICKET_STAFF_ROLE_ID', key: 'ticketStaffRoleId', note: 'Staff role that can see every ticket (optional).' }
        ]
    }
};

function templateParts(template) {
    const parts = TEMPLATE_PARTS[template];
    if (!parts) throw new Error(`Unknown template: ${template}`);
    return parts;
}

const DEFAULT_SETTINGS = Object.freeze({
    embedColor: '#5865F2',
    presence: { status: 'online', activityType: 'Playing', activityText: '' },
    timezone: 'UTC',
    messages: {
        welcome: 'Welcome {user} to {server}!',
        goodbye: '{user} left {server}.',
        error: 'Something went wrong running that command. Please try again.'
    },
    disabledCommands: []
});

/** The bot's customizable settings (Phase 3 edits this file only). */
function settingsFor(project) {
    const s = project.settings || {};
    return {
        embedColor: s.embedColor || DEFAULT_SETTINGS.embedColor,
        presence: { ...DEFAULT_SETTINGS.presence, ...(s.presence || {}) },
        timezone: s.timezone || DEFAULT_SETTINGS.timezone,
        messages: { ...DEFAULT_SETTINGS.messages, ...(s.messages || {}) },
        disabledCommands: Array.isArray(s.disabledCommands) ? s.disabledCommands : []
    };
}
const settingsJson = (project) => `${JSON.stringify(settingsFor(project), null, 2)}\n`;

/** npm-safe package name from the project name. */
function packageName(name) {
    const slug = String(name || 'bot').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50);
    return slug || 'discord-bot';
}

function commonFiles(project, t, { install, register, start, test, ignore }) {
    const envLines = [
        '# Copy this file to .env and fill it in. Never share .env or commit it.',
        '# Discord Developer Portal -> your application -> Bot -> Reset Token',
        'DISCORD_TOKEN=',
        '# Developer Portal -> General Information -> Application ID',
        'DISCORD_CLIENT_ID=',
        '# Optional: a server id, to register slash commands there instantly while testing',
        'DISCORD_GUILD_ID=',
        ...t.env.flatMap((e) => [`# ${e.note}`, `${e.name}=${e.default || ''}`])
    ];
    const commandList = t.commands.map((c) => `- \`/${c}\``).join('\n');
    return {
        '.env.example': `${envLines.join('\n')}\n`,
        '.gitignore': `${['.env', ...ignore].join('\n')}\n`,
        'README.md': `# ${project.botName}

${project.description || 'A Discord bot made with ZiGBoT Studio.'}

## Set up

1. Create an application in the [Discord Developer Portal](https://discord.com/developers/applications), add a bot, and copy its token.
2. Copy \`.env.example\` to \`.env\` and fill in \`DISCORD_TOKEN\` and \`DISCORD_CLIENT_ID\` (never share \`.env\`).
3. Install: \`${install}\`
4. Register the slash commands: \`${register}\`
5. Start the bot: \`${start}\`
6. Run the tests: \`${test}\`

Invite the bot with OAuth2 → URL Generator: scopes \`bot\` and \`applications.commands\`, and only the permissions your commands need.${t.intents.includes('GuildMembers') ? '\n\nThis bot needs the **Server Members** privileged intent (Developer Portal → Bot → Privileged Gateway Intents).' : ''}

## Commands

${commandList}

## Customize

Presence, embed colour, messages and which commands are on live in \`settings.json\` (editable in ZiGBoT Studio).
`
    };
}

module.exports = { TEMPLATE_PARTS, DEFAULT_SETTINGS, templateParts, settingsFor, settingsJson, packageName, commonFiles };
