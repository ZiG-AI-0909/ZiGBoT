import { handler, json, readJson, HttpError } from '@/lib/http';
import customize from '@/lib/studio/customize';
import generators from '@/lib/studio/generators';
import { requireStudioUser, getOwnedProject, mapWriteError } from '@/lib/studio/server';

export const dynamic = 'force-dynamic';

// GET: the bot's current customization (with defaults filled in).
export const GET = handler(async (_request, { params }) => {
    const { projectId } = await params;
    const { supabase, ownerId } = await requireStudioUser();
    const project = await getOwnedProject(supabase, ownerId, projectId);
    const result = customize.validateSettings(project.settings || {}, project.template);
    return json({ settings: result.value || null, portalOnly: customize.PORTAL_ONLY });
});

// PUT { settings }: validate, save, and rewrite only the project's settings.json.
export const PUT = handler(async (request, { params }) => {
    const { projectId } = await params;
    const { supabase, ownerId } = await requireStudioUser();
    const project = await getOwnedProject(supabase, ownerId, projectId);
    const body = await readJson(request);
    const result = customize.validateSettings(body?.settings, project.template);
    if (result.errors) throw new HttpError(422, 'Some settings need fixing.', { fieldErrors: result.errors });
    const { error } = await supabase.from('studio_projects').update({ settings: result.value, updated_at: new Date().toISOString() }).eq('id', project.id).eq('owner_id', ownerId);
    if (error) throw mapWriteError(error, 'free');
    const file = generators.settingsFile({ framework: project.framework, settings: result.value });
    const { error: fileError } = await supabase.from('studio_project_files')
        .upsert({ project_id: project.id, owner_id: ownerId, path: file.path, content: file.content, updated_at: new Date().toISOString() }, { onConflict: 'project_id,path' });
    if (fileError) throw mapWriteError(fileError, 'free');
    return json({ settings: result.value });
});
