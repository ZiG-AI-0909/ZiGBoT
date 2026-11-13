/**
 * "What do you want your AI to build?" (Platform Phase 6).
 *
 * A Studio project has one specialization. It decides the onboarding card,
 * the workspace a new project opens in, the project dashboard (accent,
 * tool order, docs) and the context the AI creator gets.
 *
 * Honesty rule: `technologies` and `features` list only what Studio really
 * supports today (each feature names the module that implements it); things
 * that are planned go in `later`, which the UI labels "Coming later".
 * Stored as a single value, but kept as a list-friendly id so projects can
 * hold several specializations later.
 */
const SPECIALIZATIONS = Object.freeze([
    Object.freeze({
        id: 'coding',
        title: 'AI Coding',
        icon: 'code',
        accent: '#22d3ee',
        tagline: 'Build applications, scripts, tools, and software with AI-powered coding agents.',
        technologies: ['TypeScript', 'JavaScript', 'Python', 'Node.js', 'discord.js', 'discord.py'],
        features: [
            { label: 'AI code generation and edits you approve', source: 'dashboard/lib/studio/aiCreator.js' },
            { label: 'Project generation from starter templates', source: 'dashboard/lib/studio/generators/index.js' },
            { label: 'File editing with search and version history', source: 'dashboard/components/studio/CodeStudio.js' },
            { label: 'Debugging help: structure, syntax and lint checks', source: 'dashboard/lib/studio/checks.js' },
            { label: 'Run it on your own machine', source: 'dashboard/public/runner/zigbot-runner.mjs' }
        ],
        later: ['HTML, CSS, React and Next.js projects', 'GitHub integration', 'External coding agents'],
        workspace: 'code',
        tools: ['code', 'ai', 'customize', 'deployments', 'builder'],
        aiContext: 'The owner chose AI Coding: prefer clean, idiomatic, well-structured code, explain non-obvious changes in the plan, and keep tests passing.'
    }),
    Object.freeze({
        id: 'workflow',
        title: 'Workflow Automation',
        icon: 'flow',
        accent: '#fb923c',
        tagline: 'Design intelligent workflows, connect applications, and automate repetitive tasks.',
        technologies: ['Discord triggers and actions', 'Discord webhooks', 'REST APIs (approved hosts)', 'Schedules'],
        features: [
            { label: 'Visual node editor', source: 'dashboard/components/studio/WorkflowBuilder.js' },
            { label: 'Triggers, conditions and data transformation', source: 'dashboard/lib/studio/workflows.js' },
            { label: 'API calls to approved hosts, with SSRF protection', source: 'dashboard/lib/studio/workflows.js' },
            { label: 'Workflow debugging in a safe simulator', source: 'dashboard/lib/studio/workflows.js' },
            { label: 'Activation and scheduling with Premium', source: 'dashboard/lib/studio/entitlements.js' }
        ],
        later: ['n8n, Zapier and Power Automate connections', 'Custom JavaScript and Python nodes'],
        workspace: 'builder',
        tools: ['builder', 'ai', 'code', 'deployments', 'customize'],
        aiContext: 'The owner chose Workflow Automation: favour event-driven, step-by-step logic, small focused handlers, clear triggers and safe defaults (no mass mentions, rate-limit friendly).'
    }),
    Object.freeze({
        id: 'prompt',
        title: 'Prompt Engineering',
        icon: 'ai',
        accent: '#f472b6',
        tagline: 'Turn natural-language instructions into powerful AI agents, prompts, and development projects.',
        technologies: ['ZiGBoT AI creator', 'Claude (Anthropic API)', 'OpenAI API', 'Plain-language requests'],
        features: [
            { label: 'Build with your own Claude or OpenAI coding agent', source: 'dashboard/lib/studio/agents.js' },
            { label: 'Describe what you want in plain language', source: 'dashboard/components/studio/AiCreator.js' },
            { label: 'Multi-step plans before any code', source: 'dashboard/lib/studio/aiCreator.js' },
            { label: 'Code generation from prompts, shown as diffs', source: 'dashboard/lib/studio/aiCreator.js' },
            { label: 'Nothing is written until you approve', source: 'dashboard/app/api/studio/projects/[projectId]/ai/[proposalId]/route.js' }
        ],
        later: ['GitHub Copilot, Claude Code and Codex command-line agents', 'Prompt optimisation and saved agent setups'],
        workspace: 'ai',
        tools: ['ai', 'code', 'builder', 'deployments', 'customize'],
        aiContext: 'The owner chose Prompt Engineering: restate the request as a short numbered plan first, ask for nothing interactively, and keep each change small and explained.'
    })
]);

const IDS = SPECIALIZATIONS.map((s) => s.id);
const DEFAULT = 'coding';
const byId = (id) => SPECIALIZATIONS.find((s) => s.id === id) || SPECIALIZATIONS[0];

/** Which page a new project of this specialization opens on. */
const workspacePath = (projectId, id) => `/studio/${projectId}/${byId(id).workspace}`;

module.exports = { SPECIALIZATIONS, IDS, DEFAULT, byId, workspacePath };
