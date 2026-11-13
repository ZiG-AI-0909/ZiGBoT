import { handler, json, readJson, HttpError } from '@/lib/http';
import studio from '@/lib/studio/projects';
import { requireStudioUser, getOwnedProject, getPlan, mapWriteError } from '@/lib/studio/server';

export const dynamic = 'force-dynamic';

// GET: one of the signed-in user's projects (404 for anyone else's).
export const GET = handler(async (_request, { params }) => {
    const { projectId } = await params;
    const { supabase, ownerId } = await requireStudioUser();
    return json({ project: studio.projectView(await getOwnedProject(supabase, ownerId, projectId)) });
});

// PATCH { name?, description?, status?, visibility? }: rename, archive or unarchive.
export const PATCH = handler(async (request, { params }) => {
    const { projectId } = await params;
    const { supabase, ownerId } = await requireStudioUser();
    const project = await getOwnedProject(supabase, ownerId, projectId);
    const result = studio.validateProjectPatch(await readJson(request));
    if (result.errors) throw new HttpError(422, 'Some fields need fixing.', { fieldErrors: result.errors });
    const { data, error } = await supabase.from('studio_projects').update({ ...result.value, updated_at: new Date().toISOString() })
        .eq('id', project.id).eq('owner_id', ownerId).select('*').maybeSingle();
    if (error) throw mapWriteError(error, await getPlan(supabase, ownerId));
    if (!data) throw new HttpError(404, 'Project not found.');
    return json({ project: studio.projectView(data) });
});

// DELETE { confirmName }: the exact project name must be typed to confirm.
export const DELETE = handler(async (request, { params }) => {
    const { projectId } = await params;
    const { supabase, ownerId } = await requireStudioUser();
    const project = await getOwnedProject(supabase, ownerId, projectId);
    const body = await readJson(request);
    if (String(body?.confirmName ?? '') !== project.name) throw new HttpError(422, 'Type the project name exactly to confirm.', { fieldErrors: { confirmName: 'Does not match.' } });
    const { data, error } = await supabase.from('studio_projects').delete().eq('id', project.id).eq('owner_id', ownerId).select('id');
    if (error) throw mapWriteError(error, 'free');
    if (!data?.length) throw new HttpError(404, 'Project not found.');
    return json({ deleted: true });
});
