import { handler, json, readJson, HttpError } from '@/lib/http';
import projectFiles from '@/lib/studio/files';
import { requireStudioUser, getOwnedProject, mapWriteError } from '@/lib/studio/server';

export const dynamic = 'force-dynamic';

// One file of the owner's project. Paths are validated (no "..", no
// absolute paths, no secret files) and files are capped at 500 KB, here and
// again in the database. Every save also stores a snapshot (newest 50 kept).
const TABLE = 'studio_project_files';
const BODY_LIMIT = 600 * 1024;

async function context(params) {
    const { projectId } = await params;
    const { supabase, ownerId } = await requireStudioUser();
    const project = await getOwnedProject(supabase, ownerId, projectId);
    const files = () => supabase.from(TABLE).select('path, content').eq('project_id', project.id).eq('owner_id', ownerId);
    return { supabase, ownerId, project, files };
}

function checked(path, content) {
    const result = projectFiles.validateFileWrite(path, content);
    if (result.error) throw new HttpError(422, result.error, { fieldErrors: { path: result.error } });
    return result;
}

async function snapshot(supabase, project, ownerId, path, content) {
    const { error } = await supabase.from('studio_file_versions').insert({ project_id: project.id, owner_id: ownerId, path, content });
    if (error) throw mapWriteError(error, 'free');
}

// GET ?path=src/index.js
export const GET = handler(async (request, { params }) => {
    const { files } = await context(params);
    const path = new URL(request.url).searchParams.get('path') || '';
    if (!projectFiles.isSafePath(path)) throw new HttpError(400, 'Invalid path.');
    const { data, error } = await files().eq('path', path).maybeSingle();
    if (error) throw new Error(`File read failed: ${error.message}`);
    if (!data) throw new HttpError(404, 'File not found.');
    return json({ path: data.path, content: data.content });
});

// PUT { path, content }: save an existing file.
export const PUT = handler(async (request, { params }) => {
    const { supabase, ownerId, project } = await context(params);
    const body = await readJson(request, BODY_LIMIT);
    const { path, content } = checked(body?.path, body?.content);
    const { data, error } = await supabase.from(TABLE).update({ content, updated_at: new Date().toISOString() }).eq('project_id', project.id).eq('owner_id', ownerId).eq('path', path).select('path');
    if (error) throw mapWriteError(error, 'free');
    if (!data?.length) throw new HttpError(404, 'File not found. Create it first.');
    await snapshot(supabase, project, ownerId, path, content);
    return json({ saved: true, path });
});

// POST { path, content? }: create a file (at most 300 per project).
export const POST = handler(async (request, { params }) => {
    const { supabase, ownerId, project, files } = await context(params);
    const body = await readJson(request, BODY_LIMIT);
    const { path, content } = checked(body?.path, body?.content ?? '');
    const { data: existing } = await files().limit(projectFiles.MAX_FILES + 1);
    if ((existing || []).some((f) => f.path === path)) throw new HttpError(409, 'A file with that path already exists.');
    if ((existing || []).length >= projectFiles.MAX_FILES) throw new HttpError(403, `A project can have at most ${projectFiles.MAX_FILES} files.`);
    const { error } = await supabase.from(TABLE).insert({ project_id: project.id, owner_id: ownerId, path, content });
    if (error) throw mapWriteError(error, 'free');
    return json({ created: true, path }, 201);
});

// PATCH { from, to }: rename.
export const PATCH = handler(async (request, { params }) => {
    const { supabase, ownerId, project, files } = await context(params);
    const body = await readJson(request);
    if (!projectFiles.isSafePath(body?.from)) throw new HttpError(400, 'Invalid path.');
    const { path: to } = checked(body?.to, '');
    const { data: clash } = await files().eq('path', to).maybeSingle();
    if (clash) throw new HttpError(409, 'A file with that path already exists.');
    const { data, error } = await supabase.from(TABLE).update({ path: to, updated_at: new Date().toISOString() }).eq('project_id', project.id).eq('owner_id', ownerId).eq('path', body.from).select('path');
    if (error) throw mapWriteError(error, 'free');
    if (!data?.length) throw new HttpError(404, 'File not found.');
    return json({ renamed: true, path: to });
});

// DELETE { path }
export const DELETE = handler(async (request, { params }) => {
    const { supabase, ownerId, project } = await context(params);
    const body = await readJson(request);
    if (!projectFiles.isSafePath(body?.path)) throw new HttpError(400, 'Invalid path.');
    const { data, error } = await supabase.from(TABLE).delete().eq('project_id', project.id).eq('owner_id', ownerId).eq('path', body.path).select('path');
    if (error) throw mapWriteError(error, 'free');
    if (!data?.length) throw new HttpError(404, 'File not found.');
    return json({ deleted: true });
});
