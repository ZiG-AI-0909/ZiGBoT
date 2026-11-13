/**
 * ZiGBoT Studio, Phase 1: project rules shared by the API, the wizard and
 * the tests. CommonJS, no Next.js or Supabase in here.
 *
 * Studio is separate from ZiGBoT: nothing in src/ may import this.
 */
const { IDS: SPECIALIZATION_IDS } = require('./specializations');
const FRAMEWORKS = Object.freeze([
    { id: 'discordjs', language: 'javascript', label: 'discord.js (JavaScript)', runtime: 'Node.js 20+', library: 'discord.js 14', description: 'The most used Discord library, plain JavaScript.', start: 'npm install, then npm start' },
    { id: 'discordjs-ts', language: 'typescript', label: 'discord.js (TypeScript)', runtime: 'Node.js 20+, TypeScript 5', library: 'discord.js 14', description: 'discord.js with types: errors show up before you run the bot.', start: 'npm install, npm run build, then npm start' },
    { id: 'discordpy', language: 'python', label: 'discord.py (Python)', runtime: 'Python 3.10+', library: 'discord.py 2', description: 'The classic Python library, with slash-command support.', start: 'pip install -r requirements.txt, then python bot.py' }
]);

// Only templates that have a real generator (Phase 2) are listed.
const TEMPLATES = Object.freeze([
    { id: 'blank', label: 'Blank bot', description: 'A /ping command and the basics. Start from scratch.' },
    { id: 'moderation', label: 'Moderation bot', description: '/kick, /ban, /timeout and /purge with permission checks.' },
    { id: 'community', label: 'Community bot', description: 'Welcome messages, /poll and /serverinfo.' },
    { id: 'ai-assistant', label: 'AI assistant bot', description: '/ask answered by an OpenAI-compatible API (your key).' },
    { id: 'ticket-support', label: 'Ticket support bot', description: 'A ticket button that opens private channels, and /close.' }
]);

const PLANS = Object.freeze({ free: { label: 'Free', projects: 3 }, developer: { label: 'Developer', projects: 20 }, premium: { label: 'Premium', projects: 100 } });
const VISIBILITIES = Object.freeze(['private', 'unlisted']);
const STATUSES = Object.freeze(['active', 'archived']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9 _-]{2,39}$/;

// The five wizard steps (the API validates the result of all of them at once).
const WIZARD_STEPS = Object.freeze([
    { id: 'identity', title: 'Bot identity' },
    { id: 'framework', title: 'Framework' },
    { id: 'template', title: 'Starter template' },
    { id: 'discord', title: 'Discord application' },
    { id: 'create', title: 'Create project' }
]);

const frameworkById = (id) => FRAMEWORKS.find((f) => f.id === id) || null;
const planLimit = (plan) => (PLANS[plan] || PLANS.free).projects;

function cleanText(value, max) {
    return String(value ?? '').replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** The new project from the wizard: { value } or { errors: { field: message } }. */
function validateNewProject(input) {
    const errors = {};
    const name = cleanText(input?.name, 60);
    const botName = cleanText(input?.botName, 60);
    const description = cleanText(input?.description, 500);
    if (!PROJECT_NAME.test(name)) errors.name = 'Use 3-40 letters, numbers, spaces, - or _, starting with a letter or number.';
    if (botName.length < 2 || botName.length > 32) errors.botName = 'Bot names are 2-32 characters (Discord\'s limit).';
    else if (/@|#|:|```|discord/i.test(botName)) errors.botName = 'Discord does not allow @, #, :, ``` or the word "discord" in bot names.';
    if (description.length > 400) errors.description = 'At most 400 characters.';
    const visibility = input?.visibility ?? 'private';
    if (!VISIBILITIES.includes(visibility)) errors.visibility = 'Pick private or unlisted.';
    const framework = frameworkById(input?.framework);
    if (!framework) errors.framework = 'Pick one of the supported frameworks.';
    if (framework && input?.language !== undefined && input.language !== framework.language) errors.language = 'That language does not match the framework.';
    if (!TEMPLATES.some((t) => t.id === input?.template)) errors.template = 'Pick one of the starter templates.';
    // Optional (older clients do not send it): the onboarding choice.
    if (input?.specialization !== undefined && !SPECIALIZATION_IDS.includes(input.specialization)) errors.specialization = 'Pick one of the specializations.';
    if (Object.keys(errors).length) return { errors };
    const value = { name, bot_name: botName, description, visibility, framework: framework.id, language: framework.language, template: input.template };
    if (input?.specialization !== undefined) value.specialization = input.specialization;
    return { value };
}

/** Rename / archive / visibility changes: { value } or { errors }. */
function validateProjectPatch(input) {
    const errors = {};
    const value = {};
    if (input?.name !== undefined) {
        const name = cleanText(input.name, 60);
        if (!PROJECT_NAME.test(name)) errors.name = 'Use 3-40 letters, numbers, spaces, - or _, starting with a letter or number.';
        else value.name = name;
    }
    if (input?.description !== undefined) {
        const description = cleanText(input.description, 500);
        if (description.length > 400) errors.description = 'At most 400 characters.';
        else value.description = description;
    }
    if (input?.status !== undefined) {
        if (!STATUSES.includes(input.status)) errors.status = 'Use active or archived.';
        else value.status = input.status;
    }
    if (input?.visibility !== undefined) {
        if (!VISIBILITIES.includes(input.visibility)) errors.visibility = 'Pick private or unlisted.';
        else value.visibility = input.visibility;
    }
    const unknown = Object.keys(input || {}).filter((k) => !['name', 'description', 'status', 'visibility'].includes(k));
    if (unknown.length) errors._ = `These fields cannot be changed here: ${unknown.join(', ')}.`;
    if (!Object.keys(value).length && !Object.keys(errors).length) errors._ = 'Nothing to change.';
    return Object.keys(errors).length ? { errors } : { value };
}

/** A free name for a copy: "Name copy", "Name copy 2", ... within 40 characters. */
function copyName(name, taken) {
    const lower = new Set((taken || []).map((n) => String(n).toLowerCase()));
    for (let i = 1; i < 100; i += 1) {
        const suffix = i === 1 ? ' copy' : ` copy ${i}`;
        const candidate = `${String(name).slice(0, 40 - suffix.length).trim()}${suffix}`;
        if (!lower.has(candidate.toLowerCase())) return candidate;
    }
    return null;
}

/** Public project fields only (never owner ids or settings secrets). */
function projectView(row) {
    if (!row) return null;
    return {
        id: row.id, name: row.name, botName: row.bot_name, description: row.description, visibility: row.visibility,
        language: row.language, framework: row.framework, template: row.template, status: row.status, specialization: row.specialization || 'coding',
        createdAt: row.created_at, updatedAt: row.updated_at
    };
}

/** "studio_project_limit" from the database trigger → a friendly message. */
const isLimitError = (error) => /studio_project_limit/.test(String(error?.message || ''));
const isDuplicateNameError = (error) => error?.code === '23505' || /studio_projects_owner_name_idx/.test(String(error?.message || ''));

module.exports = {
    FRAMEWORKS, TEMPLATES, PLANS, VISIBILITIES, WIZARD_STEPS, UUID,
    frameworkById, planLimit, validateNewProject, validateProjectPatch, copyName, projectView, isLimitError, isDuplicateNameError
};
