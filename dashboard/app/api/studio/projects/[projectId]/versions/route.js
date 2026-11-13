import { handler, json, HttpError } from '@/lib/http';
import projectFiles from '@/lib/studio/files';
import { requireStudioUser, getOwnedProject } from '@/lib/studio/server';

export const dynamic = 'force-dynamic';

// GET ?path=...            → the file's snapshots (id, time, size), newest first
// GET ?path=...&id=123     → one snapshot's content (for the diff view)
export const GET = handler(async (request, { params }) => {
    const { projectId } = await params;
    const { supabase, ownerId } = await requireStudioUser();
    const project = await getOwnedProject(supabase, ownerId, projectId);
    const url = new URL(request.url);
    const path = url.searchParams.get('path') || '';
    if (!projectFiles.isSafePath(path)) throw new HttpError(400, 'Invalid path.');
    const base = () => supabase.from('studio_file_versions').select('id, path, content, created_at').eq('project_id', project.id).eq('owner_id', ownerId).eq('path', path);
    const id = url.searchParams.get('id');
    if (id) {
        if (!/^\d{1,18}$/.test(id)) throw new HttpError(400, 'Invalid version.');
        const { data, error } = await base().eq('id', Number(id)).maybeSingle();
        if (error) throw new Error(`Version read failed: ${error.message}`);
        if (!data) throw new HttpError(404, 'Version not found.');
        return json({ version: { id: data.id, createdAt: data.created_at, content: data.content } });
    }
    const { data, error } = await base().order('id', { ascending: false }).limit(50);
    if (error) throw new Error(`Version list failed: ${error.message}`);
    return json({ versions: (data || []).map((v) => ({ id: v.id, createdAt: v.created_at, size: Buffer.byteLength(v.content || '', 'utf8') })) });
});
