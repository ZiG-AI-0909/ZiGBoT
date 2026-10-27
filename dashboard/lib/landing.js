/**
 * Landing page content: every claim the homepage makes, in one place, with
 * the bot source that implements it. test/landingContent.test.js checks it
 * against the real code (premium plan, retention, commands, demo text), so
 * the page cannot quietly drift from what ZiGBoT actually does.
 *
 * CommonJS like lib/shared, so the root test suite can load it directly.
 */
const { FREE_LIMITS, PREMIUM_ONLY_FEATURES, PREMIUM_PERKS, premiumPerks } = require('./shared/premium');
const { LIMITS } = require('./shared/constants');
const { SUPPORTED_LANGUAGES } = require('./shared/languages');
const { GIF_FREQUENCIES } = require('./shared/gifs');
const { PERSONA_TEMPLATES } = require('./shared/personaTemplates');

// "English or Hinglish": the same list /setup and the dashboard dropdown use.
const LANGUAGE_LABELS = SUPPORTED_LANGUAGES.map((l) => l.label);
const orList = (items) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} or ${items.at(-1)}`);
// GIPHY's terms ask apps to show this attribution next to its content.
const GIPHY_ATTRIBUTION = 'Powered by GIPHY';

const OPT_IN_LABEL = 'Opt-in · when enabled';
const PREMIUM_LABEL = 'Premium';

const hero = {
    headline: 'Your server\'s main character just dropped.',
    pitch: 'ZiGBoT chats, roasts (nicely), remembers what you let it — and lets you delete it anytime.',
    note: 'Never asks for Administrator.'
};

// "Demo — sample conversation". Bot lines quote the bot's real output
// formats (sources listed); the conversations themselves are examples.
const demoScenes = [
    {
        id: 'chat',
        label: 'Vibes',
        sources: ['src/ai/client.js', 'dashboard/lib/shared/personas.js'],
        caption: 'Personality is set per server and per role.',
        lines: [
            { from: 'user', name: 'ava', text: '@ZiGBoT my code works and I have no idea why 😭' },
            { from: 'bot', text: 'Respect the mystery. Do NOT touch it 💀 Ship it, leave a comment that says "do not refactor", and walk away slowly.' }
        ]
    },
    {
        id: 'memory',
        label: 'Memory',
        sources: ['src/memory/retrieval.js', 'src/ai/client.js', 'src/memory/commands.js'],
        caption: 'Public answers show a count only. The details stay private.',
        lines: [
            { from: 'user', name: 'ava', text: '@ZiGBoT what do you remember about me?' },
            { from: 'bot', text: 'I have 3 memories saved for you in this server. They stay private, so I won\'t post them here — use `/memory view` to see them (only you can see that reply). 🧠🔒' },
            { from: 'user', name: 'ava', text: '/memory view' },
            {
                from: 'bot',
                ephemeral: true,
                text: '🧠 Your memories here — page 1/1, 3 total, newest first:',
                items: ['#12 [preference] my favourite game is chess — saved by you', '#9 [fact] I study design — saved by you', '#4 [event] exam on monday — saved by you']
            }
        ]
    },
    {
        id: 'music',
        label: 'Music',
        badge: PREMIUM_LABEL,
        sources: ['src/music/player.js', 'src/music/panel.js'],
        caption: 'Music needs ZiGBoT Premium for the server.',
        lines: [
            { from: 'user', name: 'kai', text: '@ZiGBoT play Believer by Imagine Dragons' },
            { from: 'bot', text: '🎵 **Now playing:** **Believer** (3:24)', buttons: ['⏸️ Pause', '⏭️ Skip', '⏹️ Stop', '🔁 Loop: Off'] }
        ]
    },
    {
        id: 'moderation',
        label: 'Moderation',
        sources: ['src/tools/router.js', 'src/security/confirmation.js', 'src/logging/auditLog.js'],
        caption: 'Destructive actions need a confirm click, and every one is logged.',
        lines: [
            { from: 'user', name: 'mod_sam', text: '@ZiGBoT warn @spammer for spam' },
            { from: 'bot', text: '⚠️ This action is destructive: **warn_member** on **@spammer spam**. Only the requesting owner or an authorized admin can confirm it.', buttons: ['Confirm', 'Cancel'] },
            { from: 'bot', text: '⚠️ Warned spammer (warning #3): spam. They now have 1 warning(s).' }
        ]
    }
];

const steps = [
    { title: 'You mention @ZiGBoT', text: 'Or reply to it, or chat in a channel your admins set up.', sources: ['src/index.js'] },
    { title: 'It reads the room', text: 'Recent messages, this server\'s persona, and your roles decide its tone. Under-18 roles always get the gentle side.', sources: ['src/ai/memory.js', 'src/guildConfig/context.js', 'src/index.js'] },
    { title: 'It checks memory you allowed', text: 'Only your memories, only if your memory is on. Stored notes are treated as data, never as instructions.', sources: ['src/memory/retrieval.js', 'src/ai/client.js'] },
    { title: 'AI writes the reply', text: 'Requests like "play" or "warn" become real actions; anything destructive asks for confirmation. Safety checks run on every reply.', sources: ['src/ai/client.js', 'src/tools/router.js', 'dashboard/lib/shared/safety.js'] },
    { title: 'You stay in control', text: 'See, fix, export, or delete what it knows with /memory. Turn it off anytime.', sources: ['src/memory/commands.js'] }
];

const features = [
    { id: 'personas', icon: '🎭', title: 'Personalities per role', text: 'Gentle for some roles, savage for others. Your server decides, role by role.', sources: ['dashboard/lib/shared/personas.js', 'src/guildConfig/context.js'] },
    { id: 'languages', icon: '🗣️', title: orList(LANGUAGE_LABELS), text: `Pick ${orList(LANGUAGE_LABELS)} in /setup or the dashboard. The humour follows: international jokes in English, desi humour in Hinglish.`, sources: ['src/guildConfig/setup.js', 'dashboard/lib/shared/languages.js', 'dashboard/lib/shared/personas.js'] },
    { id: 'comebacks', icon: '🔥', title: 'Comebacks with limits', text: 'Swear at it and it claps back — but never sexual, never about your family, never hateful.', sources: ['src/ai/profanityDetector.js', 'src/ai/client.js'] },
    { id: 'care', icon: '🫶', title: 'Knows when to stop joking', text: 'If someone sounds like they\'re in crisis, ZiGBoT drops the roast and answers sincerely.', sources: ['dashboard/lib/shared/safety.js'] },
    { id: 'memory', icon: '🧠', title: 'Memory you control', text: 'View, search, correct, export, forget, or clear it. Or turn it off.', sources: ['src/memory/commands.js', 'src/db/brain.js'] },
    { id: 'summaries', icon: '📝', title: 'Conversation summaries', badge: OPT_IN_LABEL, text: 'Short facts from your own chats with ZiGBoT — only if the bot has the feature on and you opt in with /memory summaries.', sources: ['src/memory/summaries.js'] },
    { id: 'summary_channels', icon: '📌', title: 'Summary channels', badge: OPT_IN_LABEL, text: 'Admins can pick channels with /summarychannels where your own messages may be summarised too — only if you opted in, only channels on the list when you did, and never threads or age-restricted channels.', sources: ['src/memory/summaryChannels.js', 'src/memory/summaries.js'] },
    { id: 'music', icon: '🎵', title: 'Music', badge: PREMIUM_LABEL, text: 'Play from YouTube (SoundCloud as backup), with a queue and buttons.', sources: ['src/music/player.js', 'src/music/sources.js', 'src/music/panel.js'], premiumFeature: 'music' },
    { id: 'voice', icon: '🎙️', title: 'Voice chat', badge: PREMIUM_LABEL, text: 'Talk to ZiGBoT in a voice channel and it talks back.', sources: ['src/voice/voiceConversation.js'], premiumFeature: 'voice' },
    {
        id: 'gifs',
        icon: '🎞️',
        title: 'Reaction GIFs',
        text: `Now and then a GIF that matches the moment, rated G and picked from ZiGBoT's own style list — never from what members type. Roast GIFs only in Savage mode, and anyone with the under-18 role gets the gentle ones. Admins pick how often (${orList(Object.keys(GIF_FREQUENCIES))}) or switch them off in /setup or the dashboard.`,
        attribution: GIPHY_ATTRIBUTION,
        sources: ['src/gifs/reactions.js', 'src/gifs/giphy.js', 'dashboard/lib/shared/gifs.js']
    },
    { id: 'moderation', icon: '🛡️', title: 'Moderation that asks first', text: 'Warn, timeout, kick, ban, clean up — with confirm buttons and an audit trail.', sources: ['src/tools/router.js', 'src/security/confirmation.js', 'src/logging/auditLog.js'] },
    { id: 'reputation', icon: '📈', title: 'Reputation', text: 'Helpful, kind members earn warmth; toxic streaks get a colder ZiGBoT. Based on the last 30 days.', sources: ['src/ai/behaviorDetector.js', 'src/db/brain.js'] },
    { id: 'dashboard', icon: '🖥️', title: 'A real dashboard', text: 'Persona, role behaviour, channels, and a live preview — on the web.', sources: ['dashboard/components/GuildEditor.js', 'dashboard/app/api/guilds/[guildId]/preview/route.js'] }
];

const privacyPoints = [
    { title: 'See everything it knows about you.', text: '/memory view and /memory export — private replies only you can see.' },
    { title: 'Fix it. Delete it. Anytime.', text: '/memory correct, /memory forget, /memory clear. Memories expire after 30 days anyway.' },
    { title: 'Private unless you share it.', text: 'Your memories only shape replies to you, unless you choose /memory share.' },
    { title: 'Notes are data, never commands.', text: 'Saved text can\'t rewrite ZiGBoT\'s rules — it\'s kept apart from its instructions.' },
    { title: 'Even the owner gets a count, not your notes.', text: 'Server owners can see how many memories you have — never what they say.' }
];

const ownerSteps = [
    { title: 'Add ZiGBoT', text: 'One click. It asks only for the permissions its tools use — never Administrator.' },
    { title: 'Run /setup', text: 'Language, owner pronouns, and the roles that mean male, female, 18+ and under-18.' },
    { title: 'Tune it on the web', text: 'Personality, role behaviour, channels, feature switches — with a live preview.' }
];

const ownerControls = [
    'Admin tools re-check your live Discord permissions on every use.',
    'Destructive actions need a confirm click.',
    'Every admin action lands in an audit log.',
    'Members only see admin-only commands if Discord lets them.'
];

const PREMIUM_FEATURE_LABELS = {
    music: 'Music in voice channels',
    voice: 'Voice chat (it talks back)'
};

// Custom bot identity (Premium). Shown only while the dashboard has it
// switched on for every server (see app/page.js). It changes ZiGBoT's name,
// picture and bio in that server only — the copy claims nothing more.
const IDENTITY_FEATURE = {
    id: 'identity',
    icon: '🪪',
    title: 'Your bot, your name',
    badge: PREMIUM_LABEL,
    premiumPerk: 'custom_identity',
    preview: 'identity',
    text: 'Rename ZiGBoT, give it a fresh pfp and a bio — just for your server. Set it from the dashboard’s Identity tab. The APP tag always stays, so it never pretends to be a person.',
    sources: ['dashboard/components/IdentityTab.js', 'dashboard/lib/shared/identity.js', 'src/identity/sync.js']
};
const IDENTITY_FAQ = {
    q: 'Can I rename the bot?',
    a: 'Yes, on Premium. Open your server in the dashboard, go to the 🪪 Identity tab, and give ZiGBoT its own name, picture and bio in that server. Changes go live as soon as you save, and Discord’s APP tag always shows.'
};
const IDENTITY_OWNER_STEP = {
    title: 'Make it yours',
    text: 'On Premium, give ZiGBoT its own name, picture and bio from the 🪪 Identity tab. Changes go live as soon as you save.',
    link: 'Open the dashboard'
};

// Comparison rows for perks that are a simple Free ✗ / Premium ✓ line.
// Every perk premiumPerks() can return must have a row (or a label here).
const PERK_ROW_LABELS = {
    custom_identity: 'Custom bot name & avatar'
};

// Free vs Premium, built from the plan rules the bot and dashboard enforce.
function premiumComparison({ customIdentity = false } = {}) {
    const perk = Object.fromEntries(PREMIUM_PERKS.map((p) => [p.key, p]));
    const rows = [
        { id: 'chat', label: 'Chat, personalities & comebacks', free: true, premium: true },
        { id: 'languages', label: `${orList(LANGUAGE_LABELS)} replies`, free: true, premium: true },
        { id: 'gifs', label: 'Reaction GIFs', free: true, premium: true },
        { id: 'memory', label: 'Memory you control (/memory)', free: true, premium: true },
        { id: 'summaries', label: 'Opt-in summaries & summary channels', free: true, premium: true },
        { id: 'moderation', label: 'Moderation tools & audit trail', free: true, premium: true },
        { id: 'setup', label: '/setup & web dashboard', free: true, premium: true },
        { id: 'ai_limits', perk: 'ai_limits', label: 'AI reply limits', free: 'Standard', premium: 'Higher' },
        { id: 'role_mappings', perk: 'role_mappings', label: 'Role mappings', free: `Up to ${FREE_LIMITS.roleMappings}`, premium: `Up to ${LIMITS.roleMappingsPerGuild}` },
        { id: 'custom_persona', perk: 'custom_persona', label: perk.custom_persona.title, free: false, premium: true },
        { id: 'persona_templates', perk: 'custom_persona', label: `${PERSONA_TEMPLATES.length} ready-made personas`, free: false, premium: true }
    ];
    for (const feature of PREMIUM_ONLY_FEATURES) {
        if (!PREMIUM_FEATURE_LABELS[feature]) throw new Error(`Add a landing label for Premium feature "${feature}" in lib/landing.js`);
        rows.push({ id: `feature_${feature}`, perk: 'voice_music', feature, label: PREMIUM_FEATURE_LABELS[feature], free: false, premium: true });
    }
    // Any other perk on the list gets its own row.
    const covered = new Set(rows.map((r) => r.perk).filter(Boolean));
    for (const p of premiumPerks({ customIdentity })) {
        if (covered.has(p.key)) continue;
        if (!PERK_ROW_LABELS[p.key]) throw new Error(`Add a landing comparison label for Premium perk "${p.key}" in lib/landing.js`);
        rows.push({ id: p.key, perk: p.key, label: PERK_ROW_LABELS[p.key], free: false, premium: true });
    }
    return rows;
}

// Ready-made custom personas (Premium), straight from the shared templates
// file the dashboard's AI behaviour tab uses.
const personaTemplates = {
    title: 'Ready-made personas',
    text: `Premium servers can start their custom persona from ${PERSONA_TEMPLATES.length} templates, then edit it in the dashboard. ZiGBoT's safety rules still apply.`,
    items: PERSONA_TEMPLATES.map(({ id, emoji, name, description }) => ({ id, emoji, name, description }))
};

// Built from the real plan numbers, so it cannot overstate them.
function freeAnswer({ customIdentity = false } = {}) {
    const perks = ['higher AI reply limits', `a custom persona (or one of ${PERSONA_TEMPLATES.length} ready-made ones)`, ...(customIdentity ? ['a custom bot name and avatar'] : []), `up to ${LIMITS.roleMappingsPerGuild} role mappings`];
    const features = PREMIUM_ONLY_FEATURES.map((f) => PREMIUM_FEATURE_LABELS[f].toLowerCase()).join(' and ');
    return `Yes. Chat, memory, moderation and setup are free (with up to ${FREE_LIMITS.roleMappings} role mappings). Premium, per server, adds ${perks.join(', ')}, and ${features}.`;
}

const faq = [
    {
        q: 'Is it free?',
        a: freeAnswer()
    },
    {
        q: 'What does it remember about me?',
        a: 'Notes you save with /memory remember, for 30 days. Conversation summaries only if the bot has them enabled and you opt in — from your chats with ZiGBoT and, if your admins chose summary channels, your own messages there. Your memories are private unless you share one.'
    },
    {
        q: 'How do I delete my data?',
        a: 'Use /memory forget for one memory or /memory clear for all of them in a server, or turn memory off with /memory off. For anything else, contact us — see the Privacy page.'
    },
    {
        q: 'Which AI does it use?',
        a: 'AI models hosted by Groq, with NVIDIA as a backup when configured. They get the message being answered plus a little recent context.'
    },
    {
        q: 'Does it work in voice?',
        a: 'Yes — on Premium servers it can join your voice channel, listen, and talk back. Music works there too.'
    }
];

/**
 * The parts of the page that depend on optional features. Without options
 * this is exactly the default page; customIdentity adds the identity card
 * (after voice), its comparison row, owner step and FAQ answer.
 */
function landingContent({ customIdentity = false } = {}) {
    if (!customIdentity) return { features, faq, ownerSteps, comparison: premiumComparison() };
    const voiceAt = features.findIndex((f) => f.id === 'voice');
    return {
        features: [...features.slice(0, voiceAt + 1), IDENTITY_FEATURE, ...features.slice(voiceAt + 1)],
        faq: [{ ...faq[0], a: freeAnswer({ customIdentity }) }, ...faq.slice(1), IDENTITY_FAQ],
        ownerSteps: [...ownerSteps, IDENTITY_OWNER_STEP],
        comparison: premiumComparison({ customIdentity })
    };
}

module.exports = {
    landingContent,
    IDENTITY_FEATURE,
    IDENTITY_FAQ,
    IDENTITY_OWNER_STEP,
    PERK_ROW_LABELS,
    hero,
    demoScenes,
    steps,
    features,
    privacyPoints,
    ownerSteps,
    ownerControls,
    premiumComparison,
    faq,
    personaTemplates,
    GIPHY_ATTRIBUTION,
    LANGUAGE_LABELS,
    OPT_IN_LABEL,
    PREMIUM_LABEL,
    PREMIUM_FEATURE_LABELS
};
