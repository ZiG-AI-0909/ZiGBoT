import { handler, json, HttpError } from '@/lib/http';
import studio from '@/lib/studio/projects';
import projectFiles from '@/lib/studio/files';
import { requireStudioUser, getOwnedProject, getPlan, mapWriteError } from '@/lib/studio/server';

export const dynamic = 'force-dynamic';

// POST: copy one of the signed-in user's projects with its files (counts
// towards the plan limit). Rolled back if the files cannot be copied.
export const POST = handler(async (_request, { params }) => {
    const { projectId } = await params;
    const { supabase, ownerId } = await requireStudioUser();
    const project = await getOwnedProject(supabase, ownerId, projectId);
    const { data: mine } = await supabase.from('studio_projects').select('name').eq('owner_id', ownerId).limit(200);
    const name = studio.copyName(project.name, (mine || []).map((p) => p.name));
    if (!name) throw new HttpError(409, 'Too many copies with this name already.');
    const plan = await getPlan(supabase, ownerId);
    const { id: _id, created_at: _created, updated_at: _updated, ...rest } = project;
    const { data, error } = await supabase.from('studio_projects').insert({ ...rest, name, status: 'active', owner_id: ownerId }).select('*').single();
    if (error) throw mapWriteError(error, plan);

    const { data: files, error: readError } = await supabase.from('studio_project_files').select('path, content').eq('project_id', project.id).eq('owner_id', ownerId).limit(1000);
    const copy = readError ? null : await supabase.from('studio_project_files').insert(projectFiles.fileRows(files || [], { projectId: data.id, ownerId }));
    if (readError || copy?.error) {
        await supabase.from('studio_projects').delete().eq('id', data.id).eq('owner_id', ownerId);
        throw mapWriteError(readError || copy.error, plan);
    }
    return json({ project: studio.projectView(data) }, 201);
});
