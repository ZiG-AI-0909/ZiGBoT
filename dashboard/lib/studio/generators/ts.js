/**
 * discord.js 14 project generator, TypeScript (strict), compiled with tsc.
 * Pure: returns { path: content } and never runs anything.
 */
const shared = require('./shared');

const HEAD = "import { SlashCommandBuilder, type ChatInputCommandInteraction";
const mod = (name, extraImports, builder, body) => `${HEAD}${extraImports} } from 'discord.js';
import type { Command } from '../types';

const command: Command = {
    data: ${builder},
    async execute(interaction: ChatInputCommandInteraction) {
${body}
    }
};

export default command;
`;

const COMMANDS = {
    ping: mod('ping', ', MessageFlags', "new SlashCommandBuilder().setName('ping').setDescription('Check that the bot is alive')",
        "        await interaction.reply({ content: `Pong! ${Math.round(interaction.client.ws.ping)} ms`, flags: MessageFlags.Ephemeral });"),
    kick: mod('kick', ', PermissionFlagsBits, MessageFlags, type GuildMember', `new SlashCommandBuilder()
        .setName('kick')
        .setDescription('Kick a member')
        .addUserOption((o) => o.setName('member').setDescription('Who to kick').setRequired(true))
        .addStringOption((o) => o.setName('reason').setDescription('Why').setMaxLength(400))
        .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers)`, `        const member = interaction.options.getMember('member') as GuildMember | null;
        const reason = interaction.options.getString('reason') ?? 'No reason given';
        if (!member) { await interaction.reply({ content: 'That member is not in this server.', flags: MessageFlags.Ephemeral }); return; }
        if (!member.kickable || !outranks(interaction.member as GuildMember, member)) {
            await interaction.reply({ content: 'I cannot kick that member (role hierarchy or permissions).', flags: MessageFlags.Ephemeral });
            return;
        }
        await member.kick(reason);
        await interaction.reply({ content: \`Kicked \${member.user.tag}.\`, flags: MessageFlags.Ephemeral });`),
    ban: mod('ban', ', PermissionFlagsBits, MessageFlags, type GuildMember', `new SlashCommandBuilder()
        .setName('ban')
        .setDescription('Ban a member')
        .addUserOption((o) => o.setName('member').setDescription('Who to ban').setRequired(true))
        .addStringOption((o) => o.setName('reason').setDescription('Why').setMaxLength(400))
        .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)`, `        const member = interaction.options.getMember('member') as GuildMember | null;
        const reason = interaction.options.getString('reason') ?? 'No reason given';
        if (!member) { await interaction.reply({ content: 'That member is not in this server.', flags: MessageFlags.Ephemeral }); return; }
        if (!member.bannable || !outranks(interaction.member as GuildMember, member)) {
            await interaction.reply({ content: 'I cannot ban that member (role hierarchy or permissions).', flags: MessageFlags.Ephemeral });
            return;
        }
        await member.ban({ reason });
        await interaction.reply({ content: \`Banned \${member.user.tag}.\`, flags: MessageFlags.Ephemeral });`),
    timeout: mod('timeout', ', PermissionFlagsBits, MessageFlags, type GuildMember', `new SlashCommandBuilder()
        .setName('timeout')
        .setDescription('Time out a member')
        .addUserOption((o) => o.setName('member').setDescription('Who').setRequired(true))
        .addIntegerOption((o) => o.setName('minutes').setDescription('1 to 40320 (28 days)').setRequired(true).setMinValue(1).setMaxValue(40320))
        .addStringOption((o) => o.setName('reason').setDescription('Why').setMaxLength(400))
        .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)`, `        const member = interaction.options.getMember('member') as GuildMember | null;
        const minutes = interaction.options.getInteger('minutes', true);
        const reason = interaction.options.getString('reason') ?? 'No reason given';
        if (!member) { await interaction.reply({ content: 'That member is not in this server.', flags: MessageFlags.Ephemeral }); return; }
        if (!member.moderatable || !outranks(interaction.member as GuildMember, member)) {
            await interaction.reply({ content: 'I cannot time out that member (role hierarchy or permissions).', flags: MessageFlags.Ephemeral });
            return;
        }
        await member.timeout(minutes * 60_000, reason);
        await interaction.reply({ content: \`Timed out \${member.user.tag} for \${minutes} minute(s).\`, flags: MessageFlags.Ephemeral });`),
    purge: mod('purge', ', PermissionFlagsBits, MessageFlags, type GuildTextBasedChannel', `new SlashCommandBuilder()
        .setName('purge')
        .setDescription('Delete recent messages in this channel')
        .addIntegerOption((o) => o.setName('count').setDescription('1 to 100').setRequired(true).setMinValue(1).setMaxValue(100))
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)`, `        const count = interaction.options.getInteger('count', true);
        const channel = interaction.channel as GuildTextBasedChannel;
        // true: skip messages older than 14 days (Discord cannot bulk-delete those).
        const deleted = await channel.bulkDelete(count, true);
        await interaction.reply({ content: \`Deleted \${deleted.size} message(s).\`, flags: MessageFlags.Ephemeral });`),
    poll: mod('poll', ', EmbedBuilder, MessageFlags, type ColorResolvable', `new SlashCommandBuilder()
        .setName('poll')
        .setDescription('Start a quick poll')
        .addStringOption((o) => o.setName('question').setDescription('The question').setRequired(true).setMaxLength(200))
        .addStringOption((o) => o.setName('options').setDescription('2 to 5 options separated by |').setRequired(true).setMaxLength(500))`, `        const numbers = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣'];
        const options = interaction.options.getString('options', true).split('|').map((o) => o.trim()).filter(Boolean).slice(0, 5);
        if (options.length < 2) { await interaction.reply({ content: 'Give at least two options, separated by |.', flags: MessageFlags.Ephemeral }); return; }
        const embed = new EmbedBuilder()
            .setColor(settings.embedColor as ColorResolvable)
            .setTitle(interaction.options.getString('question', true))
            .setDescription(options.map((o, i) => \`\${numbers[i]} \${o}\`).join('\\n'));
        const response = await interaction.reply({ embeds: [embed], withResponse: true, allowedMentions: { parse: [] } });
        const message = response.resource?.message;
        if (message) for (let i = 0; i < options.length; i += 1) await message.react(numbers[i]);`),
    serverinfo: mod('serverinfo', ', EmbedBuilder, type ColorResolvable', "new SlashCommandBuilder().setName('serverinfo').setDescription('About this server')", `        const guild = interaction.guild;
        if (!guild) return;
        const embed = new EmbedBuilder()
            .setColor(settings.embedColor as ColorResolvable)
            .setTitle(guild.name)
            .addFields(
                { name: 'Members', value: String(guild.memberCount), inline: true },
                { name: 'Created', value: \`<t:\${Math.floor(guild.createdTimestamp / 1000)}:D>\`, inline: true }
            );
        await interaction.reply({ embeds: [embed] });`),
    ask: mod('ask', ', MessageFlags', `new SlashCommandBuilder()
        .setName('ask')
        .setDescription('Ask the AI assistant')
        .addStringOption((o) => o.setName('question').setDescription('Your question').setRequired(true).setMaxLength(1000))`, `        if (!config.aiApiKey) { await interaction.reply({ content: 'The AI is not configured (AI_API_KEY).', flags: MessageFlags.Ephemeral }); return; }
        await interaction.deferReply();
        const response = await fetch(\`\${config.aiBaseUrl}/chat/completions\`, {
            method: 'POST',
            headers: { Authorization: \`Bearer \${config.aiApiKey}\`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: config.aiModel,
                max_tokens: 500,
                messages: [
                    { role: 'system', content: 'You are a helpful Discord assistant. Keep answers short.' },
                    { role: 'user', content: interaction.options.getString('question', true) }
                ]
            }),
            signal: AbortSignal.timeout(20_000)
        }).catch(() => null);
        const data = response && response.ok ? ((await response.json()) as { choices?: { message?: { content?: string } }[] }) : null;
        const answer = String(data?.choices?.[0]?.message?.content ?? 'The AI did not answer. Try again later.').slice(0, 1900);
        await interaction.editReply({ content: answer, allowedMentions: { parse: [] } });`),
    ticketpanel: mod('ticketpanel', ', PermissionFlagsBits, MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, type ColorResolvable, type GuildTextBasedChannel', `new SlashCommandBuilder()
        .setName('ticketpanel')
        .setDescription('Post the "open a ticket" button here')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)`, `        const embed = new EmbedBuilder().setColor(settings.embedColor as ColorResolvable).setTitle('Need help?').setDescription('Press the button to open a private ticket.');
        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId('ticket:open').setLabel('Open ticket').setStyle(ButtonStyle.Primary));
        await (interaction.channel as GuildTextBasedChannel).send({ embeds: [embed], components: [row] });
        await interaction.reply({ content: 'Ticket panel posted.', flags: MessageFlags.Ephemeral });`),
    close: mod('close', ', MessageFlags, type GuildTextBasedChannel', "new SlashCommandBuilder().setName('close').setDescription('Close this ticket')", `        const channel = interaction.channel as GuildTextBasedChannel;
        if (!channel.name.startsWith('ticket-')) { await interaction.reply({ content: 'This is not a ticket channel.', flags: MessageFlags.Ephemeral }); return; }
        await interaction.reply('Closing this ticket in 5 seconds.');
        setTimeout(() => { channel.delete('Ticket closed').catch(() => {}); }, 5_000);`)
};

// Imports a command body needs, besides discord.js (added per command).
const EXTRA = {
    kick: "import { outranks } from '../util/hierarchy';\n", ban: "import { outranks } from '../util/hierarchy';\n", timeout: "import { outranks } from '../util/hierarchy';\n",
    poll: "import { settings } from '../settings';\n", serverinfo: "import { settings } from '../settings';\n", ticketpanel: "import { settings } from '../settings';\n",
    ask: "import { config } from '../config';\n"
};

function files(project) {
    const t = shared.templateParts(project.template);
    const out = {};
    for (const name of t.commands) {
        const src = COMMANDS[name];
        const firstNewline = src.indexOf('\n', src.indexOf("from 'discord.js';")) + 1;
        out[`src/commands/${name}.ts`] = src.slice(0, firstNewline) + (EXTRA[name] || '') + src.slice(firstNewline);
    }
    out['src/commands/index.ts'] = `import type { Command } from '../types';
${t.commands.map((c) => `import ${c} from './${c}';`).join('\n')}

export const commands: Command[] = [${t.commands.join(', ')}];
`;
    out['src/types.ts'] = `import type { ChatInputCommandInteraction, SlashCommandOptionsOnlyBuilder, SlashCommandBuilder } from 'discord.js';

export interface Command {
    data: SlashCommandBuilder | SlashCommandOptionsOnlyBuilder;
    execute(interaction: ChatInputCommandInteraction): Promise<void>;
}
`;
    if (t.commands.some((c) => ['kick', 'ban', 'timeout'].includes(c))) {
        out['src/util/hierarchy.ts'] = `import type { GuildMember } from 'discord.js';

// Discord's rule for the person asking: only the owner may act on members at or above their own top role.
export function outranks(moderator: GuildMember, target: GuildMember): boolean {
    if (moderator.guild.ownerId === moderator.id) return true;
    return moderator.roles.highest.position > target.roles.highest.position;
}
`;
    }
    if (t.ticketButton) {
        out['src/buttons/ticket.ts'] = `import { ChannelType, PermissionFlagsBits, MessageFlags, type ButtonInteraction, type OverwriteResolvable } from 'discord.js';
import { config } from '../config';

// The "Open ticket" button: one private channel per member.
export async function openTicket(interaction: ButtonInteraction): Promise<void> {
    const guild = interaction.guild;
    if (!guild) return;
    const name = \`ticket-\${interaction.user.username}\`.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 90);
    const existing = guild.channels.cache.find((c) => c.name === name);
    if (existing) { await interaction.reply({ content: \`You already have a ticket: <#\${existing.id}>\`, flags: MessageFlags.Ephemeral }); return; }
    const overwrites: OverwriteResolvable[] = [
        { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
        { id: interaction.client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels] }
    ];
    if (config.ticketStaffRoleId) overwrites.push({ id: config.ticketStaffRoleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] });
    const channel = await guild.channels.create({ name, type: ChannelType.GuildText, parent: config.ticketCategoryId || undefined, permissionOverwrites: overwrites });
    await channel.send({ content: \`Hi <@\${interaction.user.id}>, describe your problem and the staff will answer. Use /close when you are done.\`, allowedMentions: { users: [interaction.user.id] } });
    await interaction.reply({ content: \`Your ticket: <#\${channel.id}>\`, flags: MessageFlags.Ephemeral });
}
`;
    }
    out['src/settings.json'] = shared.settingsJson(project);
    out['src/settings.ts'] = `import raw from './settings.json';

// Typed view of settings.json (edited in ZiGBoT Studio).
export interface Settings {
    embedColor: string;
    presence: { status: string; activityType: string; activityText: string };
    timezone: string;
    messages: { welcome: string; goodbye: string; error: string };
    disabledCommands: string[];
}

export const settings: Settings = raw;
`;
    out['src/config.ts'] = `import 'dotenv/config';

// Secrets and ids come from the environment (.env), never from the code.
export const config = {
    token: process.env.DISCORD_TOKEN ?? '',
    clientId: process.env.DISCORD_CLIENT_ID ?? '',
    guildId: process.env.DISCORD_GUILD_ID ?? ''${t.env.map((e) => `,\n    ${e.key}: process.env.${e.name} ?? ${JSON.stringify(e.default || '')}`).join('')}
};

// Called before connecting (not on import, so the offline tests run without a .env).
export function checkConfig(): void {
    if (!config.token) throw new Error('Missing DISCORD_TOKEN: copy .env.example to .env and fill it in.');
    if (!config.clientId) throw new Error('Missing DISCORD_CLIENT_ID: copy .env.example to .env and fill it in.');
}
`;
    out['src/index.ts'] = `import { Client, GatewayIntentBits, Events, ActivityType, MessageFlags, type PresenceStatusData${t.welcome ? ', type GuildMember, type PartialGuildMember' : ''} } from 'discord.js';
import { config, checkConfig } from './config';
import { settings } from './settings';
import { commands } from './commands';${t.ticketButton ? "\nimport { openTicket } from './buttons/ticket';" : ''}

const client = new Client({ intents: [${t.intents.map((i) => `GatewayIntentBits.${i}`).join(', ')}] });
const enabled = new Map(commands.filter((c) => !settings.disabledCommands.includes(c.data.name)).map((c) => [c.data.name, c]));

client.once(Events.ClientReady, (ready) => {
    console.log(\`Ready as \${ready.user.tag} in \${ready.guilds.cache.size} server(s).\`);
    const activityType = ActivityType[settings.presence.activityType as keyof typeof ActivityType] as ActivityType;
    ready.user.setPresence({
        status: settings.presence.status as PresenceStatusData,
        activities: settings.presence.activityText ? [{ name: settings.presence.activityText, type: activityType }] : []
    });
});

client.on(Events.InteractionCreate, async (interaction) => {
    try {${t.ticketButton ? `
        if (interaction.isButton() && interaction.customId === 'ticket:open') { await openTicket(interaction); return; }` : ''}
        if (!interaction.isChatInputCommand()) return;
        const command = enabled.get(interaction.commandName);
        if (command) await command.execute(interaction);
    } catch (error) {
        console.error('[command error]', error);
        if (interaction.isRepliable()) {
            const reply = { content: settings.messages.error, flags: MessageFlags.Ephemeral } as const;
            if (interaction.replied || interaction.deferred) await interaction.followUp(reply).catch(() => {});
            else await interaction.reply(reply).catch(() => {});
        }
    }
});
${t.welcome ? `
async function announce(member: GuildMember | PartialGuildMember, template: string, ping: boolean): Promise<void> {
    if (!config.welcomeChannelId || member.user?.bot) return;
    const channel = member.guild.channels.cache.get(config.welcomeChannelId);
    if (!channel || !channel.isTextBased()) return;
    const who = ping ? \`<@\${member.id}>\` : (member.user?.username ?? 'Someone');
    const text = template.replaceAll('{user}', who).replaceAll('{server}', member.guild.name);
    await channel.send({ content: text, allowedMentions: ping ? { users: [member.id] } : { parse: [] } }).catch((error) => console.error('[welcome]', error));
}
client.on(Events.GuildMemberAdd, (member) => { void announce(member, settings.messages.welcome, true); });
client.on(Events.GuildMemberRemove, (member) => { void announce(member, settings.messages.goodbye, false); });
` : ''}
// Errors are logged, never crash the bot silently.
client.on(Events.Error, (error) => console.error('[client error]', error));
process.on('unhandledRejection', (error) => console.error('[unhandled rejection]', error));

checkConfig();
void client.login(config.token);
`;
    out['src/deploy-commands.ts'] = `// Registers the slash commands with Discord: npm run register
import { REST, Routes } from 'discord.js';
import { config, checkConfig } from './config';
import { settings } from './settings';
import { commands } from './commands';

checkConfig();
const body = commands.filter((c) => !settings.disabledCommands.includes(c.data.name)).map((c) => c.data.toJSON());
const rest = new REST().setToken(config.token);
const route = config.guildId ? Routes.applicationGuildCommands(config.clientId, config.guildId) : Routes.applicationCommands(config.clientId);
rest.put(route, { body })
    .then(() => console.log(\`Registered \${body.length} command(s).\`))
    .catch((error: unknown) => { console.error(error); process.exitCode = 1; });
`;
    out['src/tests/commands.test.ts'] = `// Every command has a valid slash definition and an execute function.
import test from 'node:test';
import assert from 'node:assert/strict';
import { commands } from '../commands';

for (const command of commands) {
    test(\`command \${command.data.name}\`, () => {
        const json = command.data.toJSON();
        assert.match(json.name, /^[a-z0-9_-]{1,32}$/);
        assert.ok(json.description.length > 0 && json.description.length <= 100);
        assert.equal(typeof command.execute, 'function');
    });
}
`;
    out['tsconfig.json'] = JSON.stringify({
        compilerOptions: {
            target: 'ES2022', module: 'commonjs', moduleResolution: 'node', lib: ['ES2022'], types: ['node'],
            outDir: 'dist', rootDir: 'src', strict: true, esModuleInterop: true, resolveJsonModule: true, skipLibCheck: true, forceConsistentCasingInFileNames: true
        },
        include: ['src']
    }, null, 2) + '\n';
    out['package.json'] = JSON.stringify({
        name: shared.packageName(project.name),
        version: '1.0.0',
        private: true,
        description: project.description || `${project.botName}, a Discord bot made with ZiGBoT Studio`,
        main: 'dist/index.js',
        scripts: { build: 'tsc', start: 'node dist/index.js', register: 'npm run build && node dist/deploy-commands.js', test: 'npm run build && node --test dist/tests/commands.test.js', typecheck: 'tsc --noEmit' },
        engines: { node: '>=20' },
        dependencies: { 'discord.js': '^14.28.0', dotenv: '^16.4.5' },
        devDependencies: { typescript: '^5.6.3', '@types/node': '^22.9.0' }
    }, null, 2) + '\n';
    Object.assign(out, shared.commonFiles(project, t, { install: 'npm install', register: 'npm run register', start: 'npm run build && npm start', test: 'npm test', ignore: ['node_modules/', 'dist/'] }));
    return out;
}

module.exports = { files, COMMANDS };
