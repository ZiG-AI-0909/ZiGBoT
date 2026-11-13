import { handler, json } from '@/lib/http';
import projectFiles from '@/lib/studio/files';
import { requireStudioUser, getOwnedProject } from '@/lib/studio/server';

export const dynamic = 'force-dynamic';

// GET: the owner's file list (paths and sizes).
export const GET = handler(async (_request, { params }) => {
    const { projectId } = await params;
    const { supabase, ownerId } = await requireStudioUser();
    const project = await getOwnedProject(supabase, ownerId, projectId);
    const { data, error } = await supabase.from('studio_project_files').select('path, content').eq('project_id', project.id).eq('owner_id', ownerId).limit(1000);
    if (error) throw new Error(`File read failed: ${error.message}`);
    return json({ files: projectFiles.fileSummary(data) });
});
