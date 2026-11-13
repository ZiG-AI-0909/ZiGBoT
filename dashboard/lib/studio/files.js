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

const fileSummary = (rows) => (rows || []).map((r) => ({ path: r.path, size: Buffer.byteLength(r.content || '', 'utf8') })).sort((a, b) => a.path.localeCompare(b.path));

module.exports = { exportable, fileRows, fileSummary, isSafePath, MAX_FILE_BYTES, SECRET_FILE };
