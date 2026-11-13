import { handler, json } from '@/lib/http';
import projectFiles from '@/lib/studio/files';
import { requireStudioUser, getOwnedProject } from '@/lib/studio/server';

export const dynamic = 'force-dynamic';

// GET ?q=text: search the owner's project files (names and lines), max 100 hits.
export const GET = handler(async (request, { params }) => {
    const { projectId } = await params;
    const { supabase, ownerId } = await requireStudioUser();
    const project = await getOwnedProject(supabase, ownerId, projectId);
    const q = (new URL(request.url).searchParams.get('q') || '').slice(0, 100);
    const { data, error } = await supabase.from('studio_project_files').select('path, content').eq('project_id', project.id).eq('owner_id', ownerId).limit(1000);
    if (error) throw new Error(`Search failed: ${error.message}`);
    return json({ hits: projectFiles.searchFiles(data || [], q) });
});
