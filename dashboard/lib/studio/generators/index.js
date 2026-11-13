/**
 * ZiGBoT Studio project generators (Phase 2). generateProject(project) →
 * [{ path, content }], sorted. Pure functions: generated code is text for
 * the customer's own machine or a future sandbox; ZiGBoT never runs it.
 */
const js = require('./js');
const ts = require('./ts');
const py = require('./py');
const shared = require('./shared');

const BY_FRAMEWORK = { discordjs: js, 'discordjs-ts': ts, discordpy: py };
const MAX_FILE_BYTES = 500 * 1024;
const SAFE_PATH = /^[A-Za-z0-9._/-]+$/;

/** A path a project may contain: relative, no "..", no backslashes, at most 200 characters. */
function isSafePath(path) {
    const p = String(path || '');
    return p.length >= 1 && p.length <= 200 && SAFE_PATH.test(p) && !p.startsWith('/') && !p.split('/').some((part) => part === '..' || part === '' || part === '.');
}

function generateProject(project) {
    const generator = BY_FRAMEWORK[project?.framework];
    if (!generator) throw new Error(`Unsupported framework: ${project?.framework}`);
    const files = generator.files({ name: project.name, botName: project.botName || project.bot_name || project.name, description: project.description || '', template: project.template, settings: project.settings || {} });
    return Object.entries(files)
        .map(([path, content]) => {
            if (!isSafePath(path)) throw new Error(`Generator produced an unsafe path: ${path}`);
            if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) throw new Error(`Generated file too large: ${path}`);
            return { path, content };
        })
        .sort((a, b) => a.path.localeCompare(b.path));
}

/** Just the settings file (Phase 3 rewrites this one only). */
function settingsFile(project) {
    return { path: project.framework === 'discordpy' ? 'settings.json' : 'src/settings.json', content: shared.settingsJson(project) };
}

module.exports = { generateProject, settingsFile, isSafePath, MAX_FILE_BYTES, TEMPLATE_PARTS: shared.TEMPLATE_PARTS };
