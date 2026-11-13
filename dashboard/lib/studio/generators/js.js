/**
 * discord.js 14 project generator, plain JavaScript (CommonJS, Node 20+).
 * Pure: returns { path: content } and never runs anything.
 */
const shared = require('./shared');

const COMMANDS = {
    ping: `const { SlashCommandBuilder, MessageFlags } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder().setName('ping').setDescription('Check that the bot is alive'),
    async execute(interaction) {
        await interaction.reply({ content: \`Pong! \${Math.round(interaction.client.ws.ping)} ms\`, flags: MessageFlags.Ephemeral });
    }
};
`,
    kick: `const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { outranks } = require('../util/hierarchy');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('kick')
        .setDescription('Kick a member')
        .addUserOption((o) => o.setName('member').setDescription('Who to kick').setRequired(true))
        .addStringOption((o) => o.setName('reason').setDescription('Why').setMaxLength(400))
        .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers),
    async execute(interaction) {
        const member = interaction.options.getMember('member');
        const reason = interaction.options.getString('reason') || 'No reason given';
        if (!member) return interaction.reply({ content: 'That member is not in this server.', flags: MessageFlags.Ephemeral });
        if (!member.kickable || !outranks(interaction.member, member)) {
            return interaction.reply({ content: 'I cannot kick that member (role hierarchy or permissions).', flags: MessageFlags.Ephemeral });
        }
        await member.kick(reason);
        await interaction.reply({ content: \`Kicked \${member.user.tag}.\`, flags: MessageFlags.Ephemeral });
    }
};
`,
    ban: `const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { outranks } = require('../util/hierarchy');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('ban')
        .setDescription('Ban a member')
        .addUserOption((o) => o.setName('member').setDescription('Who to ban').setRequired(true))
        .addStringOption((o) => o.setName('reason').setDescription('Why').setMaxLength(400))
        .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),
    async execute(interaction) {
        const member = interaction.options.getMember('member');
        const reason = interaction.options.getString('reason') || 'No reason given';
        if (!member) return interaction.reply({ content: 'That member is not in this server.', flags: MessageFlags.Ephemeral });
        if (!member.bannable || !outranks(interaction.member, member)) {
            return interaction.reply({ content: 'I cannot ban that member (role hierarchy or permissions).', flags: MessageFlags.Ephemeral });
        }
        await member.ban({ reason });
        await interaction.reply({ content: \`Banned \${member.user.tag}.\`, flags: MessageFlags.Ephemeral });
    }
};
`,
    timeout: `const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { outranks } = require('../util/hierarchy');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('timeout')
        .setDescription('Time out a member')
        .addUserOption((o) => o.setName('member').setDescription('Who').setRequired(true))
        .addIntegerOption((o) => o.setName('minutes').setDescription('1 to 40320 (28 days)').setRequired(true).setMinValue(1).setMaxValue(40320))
        .addStringOption((o) => o.setName('reason').setDescription('Why').setMaxLength(400))
        .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
    async execute(interaction) {
        const member = interaction.options.getMember('member');
        const minutes = interaction.options.getInteger('minutes');
        const reason = interaction.options.getString('reason') || 'No reason given';
        if (!member) return interaction.reply({ content: 'That member is not in this server.', flags: MessageFlags.Ephemeral });
        if (!member.moderatable || !outranks(interaction.member, member)) {
            return interaction.reply({ content: 'I cannot time out that member (role hierarchy or permissions).', flags: MessageFlags.Ephemeral });
        }
        await member.timeout(minutes * 60_000, reason);
        await interaction.reply({ content: \`Timed out \${member.user.tag} for \${minutes} minute(s).\`, flags: MessageFlags.Ephemeral });
    }
};
`,
    purge: `const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('purge')
        .setDescription('Delete recent messages in this channel')
        .addIntegerOption((o) => o.setName('count').setDescription('1 to 100').setRequired(true).setMinValue(1).setMaxValue(100))
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),
    async execute(interaction) {
        const count = interaction.options.getInteger('count');
        // true: skip messages older than 14 days (Discord cannot bulk-delete those).
        const deleted = await interaction.channel.bulkDelete(count, true);
        await interaction.reply({ content: \`Deleted \${deleted.size} message(s).\`, flags: MessageFlags.Ephemeral });
    }
};
`,
    poll: `const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const settings = require('../settings.json');

const NUMBERS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣'];

module.exports = {
    data: new SlashCommandBuilder()
        .setName('poll')
        .setDescription('Start a quick poll')
        .addStringOption((o) => o.setName('question').setDescription('The question').setRequired(true).setMaxLength(200))
        .addStringOption((o) => o.setName('options').setDescription('2 to 5 options separated by |').setRequired(true).setMaxLength(500)),
    async execute(interaction) {
        const options = interaction.options.getString('options').split('|').map((o) => o.trim()).filter(Boolean).slice(0, 5);
        if (options.length < 2) return interaction.reply({ content: 'Give at least two options, separated by |.', ephemeral: true });
        const embed = new EmbedBuilder()
            .setColor(settings.embedColor)
            .setTitle(interaction.options.getString('question'))
            .setDescription(options.map((o, i) => \`\${NUMBERS[i]} \${o}\`).join('\\n'));
        const message = await interaction.reply({ embeds: [embed], fetchReply: true, allowedMentions: { parse: [] } });
        for (let i = 0; i < options.length; i += 1) await message.react(NUMBERS[i]);
    }
};
`,
    serverinfo: `const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const settings = require('../settings.json');

module.exports = {
    data: new SlashCommandBuilder().setName('serverinfo').setDescription('About this server'),
    async execute(interaction) {
        const guild = interaction.guild;
        const embed = new EmbedBuilder()
            .setColor(settings.embedColor)
            .setTitle(guild.name)
            .addFields(
                { name: 'Members', value: String(guild.memberCount), inline: true },
                { name: 'Created', value: \`<t:\${Math.floor(guild.createdTimestamp / 1000)}:D>\`, inline: true }
            );
        await interaction.reply({ embeds: [embed] });
    }
};
`,
    ask: `const { SlashCommandBuilder } = require('discord.js');
const config = require('../config');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('ask')
        .setDescription('Ask the AI assistant')
        .addStringOption((o) => o.setName('question').setDescription('Your question').setRequired(true).setMaxLength(1000)),
    async execute(interaction) {
        if (!config.aiApiKey) return interaction.reply({ content: 'The AI is not configured (AI_API_KEY).', ephemeral: true });
        await interaction.deferReply();
        const response = await fetch(\`\${config.aiBaseUrl}/chat/completions\`, {
            method: 'POST',
            headers: { Authorization: \`Bearer \${config.aiApiKey}\`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: config.aiModel,
                max_tokens: 500,
                messages: [
                    { role: 'system', content: 'You are a helpful Discord assistant. Keep answers short.' },
                    { role: 'user', content: interaction.options.getString('question') }
                ]
            }),
            signal: AbortSignal.timeout(20_000)
        }).catch(() => null);
        const data = response && response.ok ? await response.json() : null;
        const answer = String(data?.choices?.[0]?.message?.content || 'The AI did not answer. Try again later.').slice(0, 1900);
        await interaction.editReply({ content: answer, allowedMentions: { parse: [] } });
    }
};
`,
    ticketpanel: `const { SlashCommandBuilder, PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const settings = require('../settings.json');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('ticketpanel')
        .setDescription('Post the "open a ticket" button here')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
    async execute(interaction) {
        const embed = new EmbedBuilder().setColor(settings.embedColor).setTitle('Need help?').setDescription('Press the button to open a private ticket.');
        const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('ticket:open').setLabel('Open ticket').setStyle(ButtonStyle.Primary));
        await interaction.channel.send({ embeds: [embed], components: [row] });
        await interaction.reply({ content: 'Ticket panel posted.', ephemeral: true });
    }
};
`,
    close: `const { SlashCommandBuilder } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder().setName('close').setDescription('Close this ticket'),
    async execute(interaction) {
        if (!interaction.channel.name.startsWith('ticket-')) {
            return interaction.reply({ content: 'This is not a ticket channel.', ephemeral: true });
        }
        await interaction.reply('Closing this ticket in 5 seconds.');
        setTimeout(() => interaction.channel.delete('Ticket closed').catch(() => {}), 5_000);
    }
};
`
};

const TICKET_BUTTON = `const { ChannelType, PermissionFlagsBits } = require('discord.js');
const config = require('../config');

// The "Open ticket" button: one private channel per member.
module.exports = async function openTicket(interaction) {
    const guild = interaction.guild;
    const name = \`ticket-\${interaction.user.username}\`.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 90);
    const existing = guild.channels.cache.find((c) => c.name === name);
    if (existing) return interaction.reply({ content: \`You already have a ticket: <#\${existing.id}>\`, ephemeral: true });
    const overwrites = [
        { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
        { id: interaction.client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels] }
    ];
    if (config.ticketStaffRoleId) overwrites.push({ id: config.ticketStaffRoleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] });
    const channel = await guild.channels.create({ name, type: ChannelType.GuildText, parent: config.ticketCategoryId || undefined, permissionOverwrites: overwrites });
    await channel.send({ content: \`Hi <@\${interaction.user.id}>, describe your problem and the staff will answer. Use /close when you are done.\`, allowedMentions: { users: [interaction.user.id] } });
    await interaction.reply({ content: \`Your ticket: <#\${channel.id}>\`, ephemeral: true });
};
`;

function files(project) {
    const t = shared.templateParts(project.template);
    const out = {};
    for (const name of t.commands) out[`src/commands/${name}.js`] = COMMANDS[name];
    if (t.commands.some((c) => ['kick', 'ban', 'timeout'].includes(c))) {
        out['src/util/hierarchy.js'] = `// Discord's rule for the person asking: only the owner may act on members at or above their own top role.
function outranks(moderator, target) {
    if (moderator.guild.ownerId === moderator.id) return true;
    return moderator.roles.highest.position > target.roles.highest.position;
}

module.exports = { outranks };
`;
    }
    if (t.ticketButton) out['src/buttons/ticket.js'] = TICKET_BUTTON;

    out['src/settings.json'] = shared.settingsJson(project);
    out['src/config.js'] = `// Secrets and ids come from the environment (.env), never from the code.
require('dotenv').config();

const config = {
    token: process.env.DISCORD_TOKEN || '',
    clientId: process.env.DISCORD_CLIENT_ID || '',
    guildId: process.env.DISCORD_GUILD_ID || ''${t.env.map((e) => `,\n    ${e.key}: process.env.${e.name} || ${JSON.stringify(e.default || '')}`).join('')}
};

// Called before connecting (not on import, so the offline tests run without a .env).
config.check = function check() {
    for (const [key, name] of [['token', 'DISCORD_TOKEN'], ['clientId', 'DISCORD_CLIENT_ID']]) {
        if (!config[key]) throw new Error(\`Missing \${name}: copy .env.example to .env and fill it in.\`);
    }
};

module.exports = config;
`;
    out['src/index.js'] = `const fs = require('node:fs');
const path = require('node:path');
const { Client, Collection, GatewayIntentBits, Events, ActivityType } = require('discord.js');
const config = require('./config');
const settings = require('./settings.json');

const client = new Client({ intents: [${t.intents.map((i) => `GatewayIntentBits.${i}`).join(', ')}] });

// Commands: every file in src/commands exports { data, execute }.
client.commands = new Collection();
for (const file of fs.readdirSync(path.join(__dirname, 'commands')).filter((f) => f.endsWith('.js'))) {
    const command = require(path.join(__dirname, 'commands', file));
    if (settings.disabledCommands.includes(command.data.name)) continue;
    client.commands.set(command.data.name, command);
}

// Events: every file in src/events exports { name, once?, execute }.
for (const file of fs.readdirSync(path.join(__dirname, 'events')).filter((f) => f.endsWith('.js'))) {
    const event = require(path.join(__dirname, 'events', file));
    if (event.once) client.once(event.name, (...args) => event.execute(...args));
    else client.on(event.name, (...args) => event.execute(...args));
}

client.once(Events.ClientReady, () => {
    client.user.setPresence({
        status: settings.presence.status,
        activities: settings.presence.activityText ? [{ name: settings.presence.activityText, type: ActivityType[settings.presence.activityType] }] : []
    });
});

// Errors are logged, never crash the bot silently.
client.on(Events.Error, (error) => console.error('[client error]', error));
process.on('unhandledRejection', (error) => console.error('[unhandled rejection]', error));

config.check();
client.login(config.token);
`;
    out['src/events/ready.js'] = `const { Events } = require('discord.js');

module.exports = {
    name: Events.ClientReady,
    once: true,
    execute(client) {
        console.log(\`Ready as \${client.user.tag} in \${client.guilds.cache.size} server(s).\`);
    }
};
`;
    out['src/events/interactionCreate.js'] = `const { Events, MessageFlags } = require('discord.js');
const settings = require('../settings.json');${t.ticketButton ? "\nconst openTicket = require('../buttons/ticket');" : ''}

module.exports = {
    name: Events.InteractionCreate,
    async execute(interaction) {
        try {${t.ticketButton ? `
            if (interaction.isButton() && interaction.customId === 'ticket:open') return await openTicket(interaction);` : ''}
            if (!interaction.isChatInputCommand()) return;
            const command = interaction.client.commands.get(interaction.commandName);
            if (!command) return;
            await command.execute(interaction);
        } catch (error) {
            console.error(\`[command error] \${interaction.commandName || interaction.customId}\`, error);
            const reply = { content: settings.messages.error, flags: MessageFlags.Ephemeral };
            if (interaction.replied || interaction.deferred) await interaction.followUp(reply).catch(() => {});
            else await interaction.reply(reply).catch(() => {});
        }
    }
};
`;
    if (t.welcome) {
        out['src/events/guildMemberAdd.js'] = `const { Events } = require('discord.js');
const config = require('../config');
const settings = require('../settings.json');

module.exports = {
    name: Events.GuildMemberAdd,
    async execute(member) {
        if (!config.welcomeChannelId || member.user.bot) return;
        const channel = member.guild.channels.cache.get(config.welcomeChannelId);
        if (!channel) return;
        const text = settings.messages.welcome.replaceAll('{user}', \`<@\${member.id}>\`).replaceAll('{server}', member.guild.name);
        await channel.send({ content: text, allowedMentions: { users: [member.id] } }).catch((error) => console.error('[welcome]', error));
    }
};
`;
        out['src/events/guildMemberRemove.js'] = `const { Events } = require('discord.js');
const config = require('../config');
const settings = require('../settings.json');

module.exports = {
    name: Events.GuildMemberRemove,
    async execute(member) {
        if (!config.welcomeChannelId || member.user.bot) return;
        const channel = member.guild.channels.cache.get(config.welcomeChannelId);
        if (!channel) return;
        const text = settings.messages.goodbye.replaceAll('{user}', member.user.username).replaceAll('{server}', member.guild.name);
        await channel.send({ content: text, allowedMentions: { parse: [] } }).catch((error) => console.error('[goodbye]', error));
    }
};
`;
    }
    out['src/deploy-commands.js'] = `// Registers the slash commands with Discord: npm run register
// With DISCORD_GUILD_ID set, they appear in that server at once (good for testing);
// without it they are global (can take up to an hour).
const fs = require('node:fs');
const path = require('node:path');
const { REST, Routes } = require('discord.js');
const config = require('./config');
const settings = require('./settings.json');

const commands = fs.readdirSync(path.join(__dirname, 'commands')).filter((f) => f.endsWith('.js'))
    .map((file) => require(path.join(__dirname, 'commands', file)))
    .filter((command) => !settings.disabledCommands.includes(command.data.name))
    .map((command) => command.data.toJSON());

config.check();
const rest = new REST().setToken(config.token);
const route = config.guildId ? Routes.applicationGuildCommands(config.clientId, config.guildId) : Routes.applicationCommands(config.clientId);
rest.put(route, { body: commands })
    .then(() => console.log(\`Registered \${commands.length} command(s).\`))
    .catch((error) => { console.error(error); process.exitCode = 1; });
`;
    out['test/commands.test.js'] = `// Every command has a valid slash definition and an execute function.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const dir = path.join(__dirname, '..', 'src', 'commands');
for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    test(\`command \${file}\`, () => {
        const command = require(path.join(dir, file));
        const json = command.data.toJSON();
        assert.match(json.name, /^[a-z0-9_-]{1,32}$/);
        assert.ok(json.description.length > 0 && json.description.length <= 100);
        assert.equal(typeof command.execute, 'function');
    });
}
`;
    out['package.json'] = JSON.stringify({
        name: shared.packageName(project.name),
        version: '1.0.0',
        private: true,
        description: project.description || `${project.botName}, a Discord bot made with ZiGBoT Studio`,
        main: 'src/index.js',
        scripts: { start: 'node src/index.js', register: 'node src/deploy-commands.js', test: 'node --test' },
        engines: { node: '>=20' },
        dependencies: { 'discord.js': '^14.28.0', dotenv: '^16.4.5' }
    }, null, 2) + '\n';
    Object.assign(out, shared.commonFiles(project, t, { install: 'npm install', register: 'npm run register', start: 'npm start', test: 'npm test', ignore: ['node_modules/'] }));
    return out;
}

module.exports = { files, COMMANDS };
