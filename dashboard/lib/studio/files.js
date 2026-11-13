/**
 * Project file rules shared by the API and the tests (Phase 2; extended by
 * the Code Studio in Phase 4). CommonJS, pure.
 */
const { isSafePath, MAX_FILE_BYTES } = require('./generators');

// Never exported or shown: real secrets the owner may add in the editor.
const SECRET_FILE = /(^|\/)\.env(\.[^/]*)?$|\.pem$|\.key$|(^|\/)id_rsa/i;
const isExample = (path) => /(^|\/)\.env\.example$/i.test(path);

/** Files that may go into an export: everything except secret files. */
function exportable(files) {
    return (files || []).filter((f) => isSafePath(f.path) && (isExample(f.path) || !SECRET_FILE.test(f.path)));
}

/** Rows for studio_project_files from generator output. */
const fileRows = (files, { projectId, ownerId }) => files.map((f) => ({ project_id: projectId, owner_id: ownerId, path: f.path, content: f.content }));

const MAX_FILES = 300;

/** A path + content an editor may write: { path, content } or { error }. */
function validateFileWrite(path, content) {
    const p = String(path ?? '').trim();
    if (!isSafePath(p)) return { error: 'Use a relative path with letters, numbers, . _ - and /, without "..".' };
    if (SECRET_FILE.test(p) && !isExample(p)) return { error: 'Secret files (.env, keys) cannot be stored as project files. Use the encrypted environment variables.' };
    if (typeof content !== 'string') return { error: 'File content must be text.' };
    if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) return { error: 'Files are limited to 500 KB.' };
    return { path: p, content };
}

/** Full-text search across files: [{ path, line, text }], at most `limit`. */
function searchFiles(files, query, { limit = 100 } = {}) {
    const q = String(query ?? '').toLowerCase();
    if (q.length < 2) return [];
    const hits = [];
    for (const f of files) {
        if (f.path.toLowerCase().includes(q)) hits.push({ path: f.path, line: 0, text: '(file name)' });
        const lines = String(f.content || '').split('\n');
        for (let i = 0; i < lines.length && hits.length < limit; i += 1) {
            if (lines[i].toLowerCase().includes(q)) hits.push({ path: f.path, line: i + 1, text: lines[i].trim().slice(0, 200) });
        }
        if (hits.length >= limit) break;
    }
    return hits;
}

const fileSummary = (rows) => (rows || []).map((r) => ({ path: r.path, size: Buffer.byteLength(r.content || '', 'utf8') })).sort((a, b) => a.path.localeCompare(b.path));

module.exports = { exportable, fileRows, fileSummary, validateFileWrite, searchFiles, isSafePath, MAX_FILE_BYTES, MAX_FILES, SECRET_FILE };
