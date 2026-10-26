/**
 * /setup: ZiGBoT asks each server for the things it cannot work out by
 * itself — the language, the owner's gender, and which roles mean male /
 * female / 18+ / under 18. Answers are saved per server (guildStore.saveSetup)
 * and used by resolveMemberBehavior and the personas.
 */
const { PermissionFlagsBits } = require('discord.js');

const INTENSITY_LABEL = { mild: 'Mild', spicy: 'Spicy', savage: 'Savage' };
const OWNER_LABEL = { 'he/him': 'Male (he/him)', 'she/her': 'Female (she/her)', 'they/them': 'Not specified (they/them)' };

const WELCOME_MESSAGE = [
    '👋 Thanks for adding **ZiGBoT**!',
    'Server admins: please run **/setup** so I know:',
    '• **Language**: English (English humour) or Hinglish (desi humour)',
    "• **The owner's gender**, since I can't tell it by myself",
    '• **Which role means male / female**',
    '• **Which role means 18+ / under 18**: I roast 18+ members and stay soft and clean with under-18s',
    'You can run /setup again any time to change it.'
].join('\n');

/** Problems with the picked roles, or null. Pure, so it can be tested. */
function setupRoleProblem({ guildId, roles }) {
    const picked = Object.entries(roles).filter(([, role]) => role);
    for (const [label, role] of picked) {
        if (String(role.id) === String(guildId)) return `@everyone can't be used as the ${label} role.`;
        if (role.managed) return `${role.name} belongs to a bot or integration, so it can't be the ${label} role.`;
    }
    if (roles.male && roles.female && roles.male.id === roles.female.id) return 'The male and female roles must be different roles.';
    if (roles.adult && roles['under-18'] && roles.adult.id === roles['under-18'].id) return 'The 18+ and under-18 roles must be different roles.';
    return null;
}

// Only shown when /setup changed GIF settings.
function gifLine(gifs) {
    if (!gifs) return '';
    if (!gifs.enabled) return '• Reaction GIFs: **off**';
    const frequency = gifs.modes?.gentle?.frequency || 'normal';
    return `• Reaction GIFs: **on** (${frequency}), roast GIFs in Savage mode: **${gifs.modes?.savage?.roast === false ? 'off' : 'on'}**. Styles per mode are in the dashboard.`;
}

function summary(saved, roles) {
    const line = (label, role) => `• ${label}: ${role ? `<@&${role.id}>` : 'not set'}`;
    return [
        '✅ **ZiGBoT is set up for this server.**',
        `• Language: **${saved.language}**`,
        `• Owner: **${OWNER_LABEL[saved.owner_pronouns] || 'not set'}**`,
        line('Male role', roles.male),
        line('Female role', roles.female),
        line('18+ role (roast mode)', roles.adult),
        line('Under-18 role (always gentle)', roles['under-18']),
        roles['under-18'] ? '' : '⚠️ No under-18 role set: if you have younger members, add one so they are never roasted.',
        saved.roast_intensity ? `• Savage roast intensity: **${INTENSITY_LABEL[saved.roast_intensity]}** (under-18s still always get Gentle)` : '',
        gifLine(saved.gif_settings),
        'Run /setup again any time to change this.'
    ].filter(Boolean).join('\n');
}

/** Returns the reply text. Never throws. */
async function handleSetupCommand(interaction, guildStore) {
    const guild = interaction.guild;
    if (!guild) return '❌ /setup only works inside a server.';
    const allowed = interaction.user.id === guild.ownerId
        || interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
    if (!allowed) return '❌ Only the server owner or members with **Manage Server** can run /setup.';

    const roles = {
        male: interaction.options.getRole('male_role'),
        female: interaction.options.getRole('female_role'),
        adult: interaction.options.getRole('adult_role'),
        'under-18': interaction.options.getRole('under18_role')
    };
    const problem = setupRoleProblem({ guildId: guild.id, roles });
    if (problem) return `❌ ${problem}`;

    try {
        const saved = await guildStore.saveSetup(guild, {
            language: interaction.options.getString('language', true),
            ownerPronouns: interaction.options.getString('owner_gender', true),
            maleRoleIds: roles.male ? [roles.male.id] : [],
            femaleRoleIds: roles.female ? [roles.female.id] : [],
            adultRoleIds: roles.adult ? [roles.adult.id] : [],
            minorRoleIds: roles['under-18'] ? [roles['under-18'].id] : [],
            roastIntensity: interaction.options.getString('roast_intensity') || null,
            gifs: {
                enabled: interaction.options.getBoolean('gifs') ?? undefined,
                frequency: interaction.options.getString('gif_frequency') || undefined,
                roast: interaction.options.getBoolean('roast_gifs') ?? undefined
            }
        });
        return summary(saved, roles);
    } catch (error) {
        console.error(`[ZiGBoT SETUP] Save failed for guild ${guild.id}: ${error.message}`);
        return '❌ I could not save the setup right now. Please try again in a minute.';
    }
}

/** First channel the bot can talk in: the system channel, else the first text channel. */
function findWelcomeChannel(guild) {
    const me = guild.members?.me;
    const canSend = (channel) => channel?.isTextBased?.() && !channel.isThread?.()
        && channel.permissionsFor?.(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]);
    if (canSend(guild.systemChannel)) return guild.systemChannel;
    return [...(guild.channels?.cache?.values?.() || [])]
        .filter(canSend)
        .sort((a, b) => (a.rawPosition || 0) - (b.rawPosition || 0))[0] || null;
}

async function sendWelcome(guild) {
    const channel = findWelcomeChannel(guild);
    if (!channel) return false;
    await channel.send({ content: WELCOME_MESSAGE, allowedMentions: { parse: [] } });
    return true;
}

module.exports = { handleSetupCommand, sendWelcome, setupRoleProblem, findWelcomeChannel, WELCOME_MESSAGE };
