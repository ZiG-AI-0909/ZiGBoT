/**
 * ZiGBoT Studio, Phase 8: template marketplace + plans.
 *
 * Publishing copies a project's exportable files (never .env/keys) into a
 * template, runs a STATIC scan and puts it in "pending review"; only a
 * Super Admin can publish it. Templates containing a credential are refused
 * outright. Installing (cloning) a template only copies text files into a
 * new project of the installer: nothing is executed, ever.
 *
 * Plans (Free / Developer / Premium) are flags in studio_accounts, set by
 * the service role only; their limits are enforced on the backend. Payments
 * are BLOCKED: there is no Studio payment provider.
 */
const projectFiles = require('./files');
const { PLANS } = require('./projects');

const PLAN_LIMITS = Object.freeze({
    free: { projects: PLANS.free.projects, aiPerDay: 20, templates: 1, simulatorRunsPerDay: 200 },
    developer: { projects: PLANS.developer.projects, aiPerDay: 100, templates: 10, simulatorRunsPerDay: 1000 },
    premium: { projects: PLANS.premium.projects, aiPerDay: 300, templates: 50, simulatorRunsPerDay: 5000 }
});
const limitsFor = (plan) => PLAN_LIMITS[plan] || PLAN_LIMITS.free;

const BILLING = Object.freeze({ status: 'blocked', reason: 'Payments are not available: Studio has no payment provider yet. Plans are set by the ZiGBoT team.' });

const MAX_TEMPLATE_BYTES = 5 * 1024 * 1024;

// Credentials: any hit blocks publishing.
const SECRET_RULES = [
    ['discord-token', /[MN][A-Za-z\d_-]{23,25}\.[\w-]{6}\.[\w-]{27,}/],
    ['discord-webhook', /discord(?:app)?\.com\/api\/webhooks\/\d{17,20}\/[\w-]{30,}/i],
    ['openai-key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/],
    ['groq-key', /\bgsk_[A-Za-z0-9]{20,}/],
    ['nvidia-key', /\bnvapi-[A-Za-z0-9_-]{20,}/],
    ['github-token', /\bgh[pousr]_[A-Za-z0-9]{30,}/],
    ['aws-key', /\bAKIA[0-9A-Z]{16}\b/],
    ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----/],
    ['supabase-service-key', /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/]
];
// Risky code: flagged for the reviewer.
const CODE_RULES = [
    ['eval', /\beval\s*\(|(?<![\w.$])Function\s*\(|\bexec\s*\(\s*compile\(/],
    ['child-process', /child_process|\bexecSync\s*\(|\bspawn(?:Sync)?\s*\(|\bos\.system\s*\(|\bsubprocess\.|\bos\.popen\s*\(/],
    ['vm', /require\(\s*['"](?:node:)?vm['"]\s*\)|\bimportlib\.import_module\s*\(/],
    ['dynamic-require', /require\(\s*[^'"`\s)]/],
    ['obfuscation-escapes', /(?:\\x[0-9a-f]{2}){12,}|(?:\\u[0-9a-f]{4}){12,}/i],
    ['obfuscation-charcode', /String\.fromCharCode\((?:\s*\d+\s*,){8,}|\bchr\(\d+\)\s*\+\s*chr\(/],
    ['obfuscation-blob', /['"`][A-Za-z0-9+/=]{300,}['"`]|['"`][0-9a-f]{300,}['"`]/i],
    ['obfuscation-decode-exec', /(?:atob|Buffer\.from)\([^)]*\)[\s\S]{0,40}(?:eval|Function|exec)|base64\.b64decode\([^)]*\)[\s\S]{0,40}exec|(?:eval|Function|exec)\s*\(\s*(?:atob|Buffer\.from|base64\.b64decode)\s*\(/]
];

/** Static scan only (text matching; nothing is parsed into code or run). */
function scanFiles(files) {
    const findings = [];
    for (const f of files) {
        const lines = String(f.content ?? '').split('\n');
        lines.forEach((line, i) => {
            for (const [rule, re] of SECRET_RULES) if (re.test(line)) findings.push({ path: f.path, line: i + 1, rule, severity: 'block' });
            if (f.path.endsWith('.md')) return;
            for (const [rule, re] of CODE_RULES) if (re.test(line)) findings.push({ path: f.path, line: i + 1, rule, severity: 'review' });
            if (line.length > 1000 && /\.(js|ts|py)$/.test(f.path)) findings.push({ path: f.path, line: i + 1, rule: 'minified-line', severity: 'review' });
        });
        if (projectFiles.SECRET_FILE.test(f.path) && !/\.env\.example$/.test(f.path)) findings.push({ path: f.path, line: 0, rule: 'secret-file', severity: 'block' });
    }
    return { blocked: findings.some((x) => x.severity === 'block'), findings: findings.slice(0, 200) };
}

/** Files a template is made of: exportable text only, size-checked. */
function templateFiles(files) {
    const list = projectFiles.exportable(files).map((f) => ({ path: f.path, content: String(f.content ?? '') }));
    for (const f of list) { const c = projectFiles.validateFileWrite(f.path, f.content); if (c.error) return { error: `${f.path}: ${c.error}` }; }
    if (list.length === 0) return { error: 'The project has no files to publish.' };
    if (list.length > projectFiles.MAX_FILES) return { error: `Templates are limited to ${projectFiles.MAX_FILES} files.` };
    if (list.reduce((n, f) => n + Buffer.byteLength(f.content, 'utf8'), 0) > MAX_TEMPLATE_BYTES) return { error: 'Templates are limited to 5 MB.' };
    return { files: list };
}

function validateListing(input) {
    const name = String(input?.name ?? '').trim();
    const description = String(input?.description ?? '').trim();
    const errors = {};
    if (name.length < 3 || name.length > 60 || !/^[\p{L}\p{N}][\p{L}\p{N} _.'&-]*$/u.test(name)) errors.name = 'Use 3-60 letters, numbers, spaces and simple punctuation.';
    if (description.length > 500) errors.description = 'At most 500 characters.';
    if (/@everyone|@here|https?:\/\//i.test(`${name} ${description}`)) errors.description = 'No mass mentions or links in listings.';
    return Object.keys(errors).length ? { errors } : { value: { name, description } };
}

const STATUSES = ['pending_review', 'published', 'rejected', 'unpublished'];

/** Owner actions on a template status. Review decisions are Super Admin only. */
function nextStatus(current, action, { isAdmin = false } = {}) {
    if (action === 'unpublish') return ['published', 'pending_review'].includes(current) ? 'unpublished' : null;
    if (action === 'approve') return isAdmin && current === 'pending_review' ? 'published' : null;
    if (action === 'reject') return isAdmin && current === 'pending_review' ? 'rejected' : null;
    return null;
}

const publicTemplate = (t, viewerId) => ({
    id: t.id, name: t.name, description: t.description, framework: t.framework, status: t.status,
    files: Array.isArray(t.files) ? t.files.length : t.file_count ?? null,
    mine: viewerId ? t.owner_id === viewerId : false, installs: t.installs || 0,
    scan: viewerId && t.owner_id === viewerId ? t.scan : undefined, createdAt: t.created_at
});

module.exports = { PLAN_LIMITS, limitsFor, BILLING, STATUSES, scanFiles, templateFiles, validateListing, nextStatus, publicTemplate, MAX_TEMPLATE_BYTES };
