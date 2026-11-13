import { handler, json, readJson, HttpError } from '@/lib/http';
import market from '@/lib/studio/marketplace';
import studio from '@/lib/studio/projects';
import projectFiles from '@/lib/studio/files';
import { createServiceClient } from '@/lib/supabase/server';
import { isSuperAdmin, writeAdminAudit } from '@/lib/admin';
import { requireStudioUser, getPlan, mapWriteError } from '@/lib/studio/server';

export const dynamic = 'force-dynamic';

function templateId(raw) {
    if (!studio.UUID.test(String(raw || ''))) throw new HttpError(404, 'Template not found.');
    return String(raw);
}

// POST { action: 'install', name } → copy a PUBLISHED template into a new
//      project of the caller (files are text; nothing is executed).
// POST { action: 'unpublish' } → owner takes their template down.
// POST { action: 'approve' | 'reject' } → Super Admin review.
export const POST = handler(async (request, { params }) => {
    const current = await requireStudioUser();
    const { supabase, ownerId } = current;
    const id = templateId((await params).templateId);
    const body = await readJson(request);
    const action = body?.action;
    const db = createServiceClient();

    if (action === 'install') {
        // The user's own client: RLS only shows published templates (or their own).
        const { data: t, error } = await supabase.from('studio_templates').select('id, owner_id, name, description, framework, base_template, files, status').eq('id', id).maybeSingle();
        if (error) throw new Error('Template read failed.');
        if (!t || (t.status !== 'published' && t.owner_id !== ownerId)) throw new HttpError(404, 'Template not found.');
        const name = String(body?.name ?? '').trim() || studio.copyName(t.name.replace(/[^A-Za-z0-9 _-]/g, '').slice(0, 30) || 'Template bot', []);
        const botName = name.replace(/discord/gi, '').replace(/[@#:`]/g, '').trim().slice(0, 32);
        const result = studio.validateNewProject({ name, botName: botName.length >= 2 ? botName : 'My bot', description: t.description.slice(0, 400), visibility: 'private', framework: t.framework, template: t.base_template });
        if (result.errors) throw new HttpError(422, 'Pick another project name.', { fieldErrors: result.errors });
        const packed = market.templateFiles(Array.isArray(t.files) ? t.files : []);
        if (packed.error) throw new HttpError(422, packed.error);
        const plan = await getPlan(supabase, ownerId);
        const { data: project, error: projectError } = await supabase.from('studio_projects').insert({ ...result.value, owner_id: ownerId }).select('*').single();
        if (projectError) throw mapWriteError(projectError, plan);
        const { error: filesError } = await supabase.from('studio_project_files').insert(projectFiles.fileRows(packed.files, { projectId: project.id, ownerId }));
        if (filesError) {
            await supabase.from('studio_projects').delete().eq('id', project.id).eq('owner_id', ownerId);
            throw mapWriteError(filesError, plan);
        }
        if (t.owner_id !== ownerId) await db.rpc('studio_count_install', { template: t.id }).then(() => {}, () => {});
        return json({ project: studio.projectView(project) }, 201);
    }

    const { data: t, error } = await db.from('studio_templates').select('id, owner_id, status').eq('id', id).maybeSingle();
    if (error) throw new Error('Template read failed.');
    const admin = isSuperAdmin(current.discordId);
    if (!t || (t.owner_id !== ownerId && !admin)) throw new HttpError(404, 'Template not found.');
    if (action === 'unpublish' && t.owner_id !== ownerId) throw new HttpError(404, 'Template not found.');
    const next = market.nextStatus(t.status, action, { isAdmin: admin });
    if (!next) throw new HttpError(409, 'That change is not possible for this template.');
    const { data: updated, error: updateError } = await db.from('studio_templates').update({ status: next, updated_at: new Date().toISOString() }).eq('id', t.id).eq('status', t.status).select('id');
    if (updateError) throw new Error('Template update failed.');
    if (!updated?.length) throw new HttpError(409, 'The template changed meanwhile. Reload and try again.');
    if (action === 'approve' || action === 'reject') await writeAdminAudit(current, { action: `studio_template_${action}`, targetType: 'studio_template', targetId: t.id });
    return json({ status: next });
});
