import { handler, json, readJson, HttpError } from '@/lib/http';
import studio from '@/lib/studio/projects';
import generators from '@/lib/studio/generators';
import projectFiles from '@/lib/studio/files';
import { requireStudioUser, getPlan, mapWriteError } from '@/lib/studio/server';

export const dynamic = 'force-dynamic';

// GET: the signed-in user's projects (and their plan limit).
export const GET = handler(async () => {
    const { supabase, ownerId } = await requireStudioUser();
    const { data, error } = await supabase.from('studio_projects').select('*').eq('owner_id', ownerId).order('updated_at', { ascending: false }).limit(200);
    if (error) throw mapWriteError(error, 'free');
    const plan = await getPlan(supabase, ownerId);
    return json({ projects: (data || []).filter((row) => row.owner_id === ownerId).map(studio.projectView), plan, limit: studio.planLimit(plan) });
});

// POST: create a project from the wizard and generate its files. owner_id
// comes from the session, never from the request; the plan limit is enforced
// by a database trigger. If the files cannot be stored, the project is removed
// again, so there is never a project without its source.
export const POST = handler(async (request) => {
    const { supabase, ownerId } = await requireStudioUser();
    const result = studio.validateNewProject(await readJson(request));
    if (result.errors) throw new HttpError(422, 'Some fields need fixing.', { fieldErrors: result.errors });
    const plan = await getPlan(supabase, ownerId);
    const { data, error } = await supabase.from('studio_projects').insert({ ...result.value, owner_id: ownerId }).select('*').single();
    if (error) throw mapWriteError(error, plan);

    const files = generators.generateProject({ ...result.value, botName: result.value.bot_name });
    const { error: filesError } = await supabase.from('studio_project_files').insert(projectFiles.fileRows(files, { projectId: data.id, ownerId }));
    if (filesError) {
        await supabase.from('studio_projects').delete().eq('id', data.id).eq('owner_id', ownerId);
        throw mapWriteError(filesError, plan);
    }
    return json({ project: studio.projectView(data), files: projectFiles.fileSummary(files) }, 201);
});
