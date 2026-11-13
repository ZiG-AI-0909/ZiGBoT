import 'server-only';
import { HttpError } from '@/lib/http';
import studio from '@/lib/studio/projects';
import { requireStudioUser, getOwnedProject } from '@/lib/studio/server';

/** The workflow, only when the session user owns both it and its project (404 otherwise). */
export async function ownedWorkflow(params, session) {
    const { projectId, workflowId } = await params;
    const { supabase, ownerId } = session || await requireStudioUser();
    const project = await getOwnedProject(supabase, ownerId, projectId);
    if (!studio.UUID.test(String(workflowId || ''))) throw new HttpError(404, 'Workflow not found.');
    const { data, error } = await supabase.from('studio_workflows').select('*').eq('id', workflowId).eq('project_id', project.id).eq('owner_id', ownerId).maybeSingle();
    if (error) throw new Error(`Workflow read failed: ${error.message}`);
    if (!data || data.owner_id !== ownerId) throw new HttpError(404, 'Workflow not found.');
    return { supabase, ownerId, project, workflow: data };
}
