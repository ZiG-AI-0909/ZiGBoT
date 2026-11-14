/**
 * Public product pages (/features/*, /pricing): what each ZiGBoT product
 * really does, in more depth than the homepage. Every section names the
 * source files that implement it (checked by test/productPages.test.js), so
 * the pages cannot claim features that do not exist. Opt-in features say so.
 * CommonJS so the root tests can load it.
 */
const { FREE_LIMITS, PREMIUM_ONLY_FEATURES } = require('./shared/premium');
const { LIMITS } = require('./shared/constants');

const PRODUCT_PAGES = Object.freeze([
    {
        slug: 'discord-bot',
        path: '/features/discord-bot',
        nav: 'Discord Bot',
        title: 'ZiGBoT Discord Bot · AI chat, moderation, community tools and music',
        description: 'An AI Discord bot with personalities, memory you control, moderation that asks first, free Anti-Nuke, tickets, welcome messages, AFK, polls and music.',
        h1: 'The ZiGBoT Discord Bot',
        lead: 'One bot for the whole server: it talks like a member of your community, keeps the server safe, and runs the everyday tools your moderators need. Add it once and switch features on as you need them.',
        sections: [
            {
                h2: 'AI conversations with a personality',
                text: 'Mention ZiGBoT and it replies in the tone your server chose: a gentle helper, a neutral assistant, or playful roasts that never touch sensitive topics. Tones can be set per role, so the under-18 role always gets the gentle one.',
                points: ['Gentle, savage-roast and neutral tones, per server and per role', 'English or Hinglish replies', 'Optional reaction GIFs (rated G, chosen by ZiGBoT, credited to GIPHY)', 'Premium: your own custom persona or a ready-made template'],
                sources: ['src/ai/client.js', 'dashboard/lib/shared/personaTemplates.js']
            },
            {
                h2: 'Moderation that asks first',
                text: 'Warn, timeout, kick, ban, purge, slowmode and channel locks, with confirm buttons for destructive actions and a log of every action. Auto-moderation is opt-in from the dashboard.',
                points: ['Warnings with escalation and temporary punishments', 'Opt-in auto-moderation: word filters, anti-spam, anti-caps, mention-spam and invite filters', 'Case history and moderation logs', 'Admin tools re-check live Discord permissions on every use'],
                sources: ['src/tools/router.js', 'src/security/confirmation.js', 'docs/ZIGBOT_FEATURE_MATRIX.md']
            },
            {
                h2: 'Community tools',
                text: 'The things a growing server needs, configured from the website instead of a wall of commands.',
                points: ['Welcome and goodbye messages, scheduled greetings', 'Support tickets with a panel and close button', 'Polls, suggestions and reaction roles (opt-in add-ons)', 'AFK with reasons and welcome-back reports; avatar viewer'],
                sources: ['src/features/community.js', 'src/afk', 'src/avatar']
            },
            {
                h2: 'Music and voice (Premium)',
                text: 'On Premium servers ZiGBoT plays music in voice channels with a queue and buttons, and can join a voice channel to listen and talk back.',
                points: ['YouTube playback with SoundCloud as backup', 'Pause, skip, stop and loop buttons', 'Voice chat: speak to ZiGBoT and hear it answer'],
                sources: ['src/music/panel.js']
            }
        ],
        faq: [
            { q: 'Does ZiGBoT need Administrator?', a: 'No. The invite asks only for the permissions its tools use.' },
            { q: 'Is it free?', a: `Chat, memory, moderation, Anti-Nuke and community tools are free. Premium adds music, voice chat, a custom persona and higher limits (for example up to ${LIMITS.roleMappingsPerGuild} role mappings instead of ${FREE_LIMITS.roleMappings}).` }
        ]
    },
    {
        slug: 'ai-memory',
        path: '/features/ai-memory',
        nav: 'AI Memory',
        title: 'AI Memory you control · ZiGBoT remembers only what you allow',
        description: 'ZiGBoT remembers notes you save, for 30 days, and lets you see, correct, export or delete them anytime with /memory. Private unless you share.',
        h1: 'AI memory you control',
        lead: 'Most AI bots either forget everything or quietly remember everything. ZiGBoT remembers what you choose, shows you exactly what it knows, and forgets it the moment you ask.',
        sections: [
            {
                h2: 'You decide what it remembers',
                text: 'Save a note with /memory remember. Conversation summaries happen only if the server has them on and you opt in yourself with /memory summaries.',
                points: ['Notes expire after 30 days', 'Memory can be switched off per person with /memory off', 'Saved notes are treated as data, never as instructions to the bot'],
                sources: ['src/db/brain.js', 'src/memory/summaries.js']
            },
            {
                h2: 'See it, fix it, delete it',
                text: 'Every memory is visible to its owner and only its owner.',
                points: ['/memory view and /memory export: private replies only you can see', '/memory correct, /memory forget, /memory clear', 'Server owners see how many memories you have, never what they say', 'Your memories shape replies to you only, unless you /memory share one'],
                sources: ['src/memory/retrieval.js', 'src/ai/client.js']
            }
        ],
        faq: [
            { q: 'Can admins read my memories?', a: 'No. Owners see a count only. The content stays private to you unless you share it.' },
            { q: 'How do I delete everything?', a: 'Run /memory clear in that server, or /memory off to stop memory completely.' }
        ]
    },
    {
        slug: 'anti-nuke',
        path: '/features/anti-nuke',
        nav: 'Anti-Nuke',
        title: 'Free Discord Anti-Nuke · ZiGBoT protects your server',
        description: 'Free Anti-Nuke for every server: ZiGBoT watches the audit log for mass deletions, mass bans and kicks, risky permission grants, bot additions, webhook bursts and raids.',
        h1: 'Anti-Nuke, free for every server',
        lead: 'A compromised admin account or a malicious bot can wipe a server in seconds. ZiGBoT watches Discord\'s audit log and alerts your admins with clear next steps the moment something looks wrong.',
        sections: [
            {
                h2: 'What it detects',
                text: 'Each signal has a severity and a threshold you can tune from the dashboard.',
                points: ['Mass channel or role deletions and creations', 'Mass bans and kicks', 'Administrator or other dangerous permissions granted', 'Bots added with Administrator or elevated permissions', 'Webhook bursts and permission churn', 'Join raids'],
                sources: ['dashboard/lib/shared/antinuke.js']
            },
            {
                h2: 'Safe by default',
                text: 'ZiGBoT alerts first. Automatic containment (stripping dangerous roles, removing unauthorized bots) is optional and off until you switch it on, so trusted admins are never punished by surprise. Up to 25 trusted admins can be allow-listed.',
                points: ['Configurable detection window and thresholds', 'Optional containment, off by default', 'Every incident logged with its status (open, acknowledged, resolved)'],
                sources: ['dashboard/lib/shared/antinuke.js', 'dashboard/components/AntiNukeTab.js']
            }
        ],
        faq: [
            { q: 'Does Anti-Nuke cost anything?', a: 'No. It is free for every server.' },
            { q: 'What does ZiGBoT need?', a: 'Give its role View Audit Log, and keep it above the roles it should be able to manage if you turn containment on.' }
        ]
    },
    {
        slug: 'studio',
        path: '/features/studio',
        nav: 'ZiGBoT Studio',
        title: 'ZiGBoT Studio · Build your own Discord bot with AI',
        description: 'Build your own Discord bot in discord.js or discord.py: browser code editor, version history, checks, AI coding agents with your own key, and a self-hosted runner.',
        h1: 'ZiGBoT Studio: build your own Discord bot',
        lead: 'Studio gives you a real starting project, an editor in the browser, and AI help that proposes changes you review. Your bot runs on your own machine.',
        sections: [
            {
                h2: 'Start from a real project',
                text: 'Pick what your AI should build (AI Coding, Workflow Automation or Prompt Engineering), then a framework and a template. Studio generates a complete, working bot project.',
                points: ['discord.js (JavaScript or TypeScript) and discord.py', 'Templates: Blank, Moderation, Community, AI Assistant, Ticket Support', 'Template marketplace with a security scan and review'],
                sources: ['dashboard/lib/studio/generators/index.js', 'dashboard/lib/studio/specializations.js', 'dashboard/lib/studio/marketplace.js']
            },
            {
                h2: 'Code with AI, safely',
                text: 'Connect your own Claude or OpenAI API key. The agent sees only that project, proposes a plan and file changes as diffs, runs static checks on them, and writes nothing until you approve.',
                points: ['Monaco code editor, file explorer, search and version history', 'Syntax and lint checks (static: your code is never run on our servers)', 'Encrypted environment variables'],
                sources: ['dashboard/components/studio/CodeStudio.js', 'dashboard/lib/studio/agents.js', 'dashboard/lib/studio/checks.js']
            },
            {
                h2: 'Run it on your own machine',
                text: 'Pair the ZiGBoT runner on a VPS, PC or Raspberry Pi with a one-time code, then deploy, start, stop and read logs from the website.',
                points: ['Node.js 18+, no dependencies', 'Only fixed commands (install, build, start) are ever run', 'Secrets are sent only to runners you paired'],
                sources: ['dashboard/public/runner/zigbot-runner.mjs']
            }
        ],
        faq: [
            { q: 'Does ZiGBoT host my bot?', a: 'Not yet. You run it with the self-hosted runner; ZiGBoT hosting is planned.' },
            { q: 'Do I need an AI key?', a: 'Only for AI features. Without a key you can still create projects, edit code and build workflows by hand.' }
        ]
    },
    {
        slug: 'automation',
        path: '/features/automation',
        nav: 'Automation Builder',
        title: 'Discord Automation Builder · Visual workflows by ZiGBoT',
        description: 'Design Discord automations visually: triggers, conditions, actions, AI and logic blocks, validation, a safe simulator, and live runs with Premium.',
        h1: 'The ZiGBoT Automation Builder',
        lead: 'Describe what should happen when someone joins, posts or reacts, as connected blocks on a canvas. Test it in a simulator before it touches your server.',
        sections: [
            {
                h2: 'Build with blocks',
                text: 'Triggers (member joins or leaves, messages, reactions, buttons, slash commands, schedules, voice), conditions (roles, channels, permissions, account age, time, variables) and actions (messages, embeds, roles, channels, threads, timeouts, moderator alerts).',
                points: ['Logic: if/else, switch, delays, variables, loops (max 50), error handling', 'HTTP requests only to approved hosts, with SSRF protection', 'Or describe the automation in words and let your AI agent draft it'],
                sources: ['dashboard/lib/studio/workflows.js', 'dashboard/lib/studio/workflowGen.js']
            },
            {
                h2: 'Test before it runs',
                text: 'The validator catches cycles, unreachable blocks and missing settings. The simulator runs the workflow against a pretend server and shows every step; nothing is sent to Discord.',
                points: ['Execution history for test runs', 'Export any workflow as readable discord.js code'],
                sources: ['dashboard/lib/studio/workflows.js', 'dashboard/components/studio/WorkflowBuilder.js']
            },
            {
                h2: 'Run it live with Premium',
                text: 'Designing and testing are free. With Premium, activated workflows run inside your bot on your self-hosted runner, on live events and schedules. Premium is re-checked on the server at every deploy.',
                points: ['Enable or disable each workflow', 'Live logs from your runner'],
                sources: ['dashboard/lib/studio/workflowDeploy.js', 'dashboard/lib/studio/entitlements.js']
            }
        ],
        faq: [
            { q: 'Can a workflow run arbitrary code?', a: 'No. Workflows use a fixed set of blocks; there is no code block.' }
        ]
    }
]);

/** Pricing page content; numbers come from the shared plan constants. */
const PRICING = Object.freeze({
    path: '/pricing',
    title: 'Pricing · ZiGBoT Free and Premium',
    description: 'ZiGBoT is free for chat, memory, moderation and Anti-Nuke. Premium adds music, voice chat, custom personas, live automations and higher limits.',
    free: ['AI chat with personalities', 'Memory you control', 'Moderation and opt-in auto-moderation', 'Anti-Nuke', 'Tickets, welcome messages, AFK, community add-ons', `Up to ${FREE_LIMITS.roleMappings} role mappings`, 'Studio: design workflows, edit code, 1 runner, 10 AI agent runs a day', 'Server analytics: last 7 days'],
    premium: ['Everything in Free', 'Music in voice channels and voice chat', 'Custom persona and ready-made persona templates', `Up to ${LIMITS.roleMappingsPerGuild} role mappings`, 'Higher AI reply limits', 'Live Studio automations (events and schedules)', 'Studio: 3 runners, 100 AI agent runs a day, 50 variables', 'Full analytics history and CSV export'],
    premiumFeatures: PREMIUM_ONLY_FEATURES,
    sources: ['dashboard/lib/shared/premium.js', 'dashboard/lib/studio/marketplace.js']
});

module.exports = { PRODUCT_PAGES, PRICING };
