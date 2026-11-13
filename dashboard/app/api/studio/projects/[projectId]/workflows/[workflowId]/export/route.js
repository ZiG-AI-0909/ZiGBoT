import { handler, json, readJson, HttpError } from '@/lib/http';
import workflows from '@/lib/studio/workflows';
import { mapWriteError, requireStudioUser } from '@/lib/studio/server';
import { ownedWorkflow } from '@/lib/studio/workflowServer';

export const dynamic = 'force-dynamic';

// GET: the workflow as JSON (import/export between projects).
export const GET = handler(async (_request, { params }) => {
    const { workflow } = await ownedWorkflow(params, await requireStudioUser());
    return json({ name: workflow.name, graph: workflow.graph });
});

// POST { write?: true }: the workflow as discord.js code. With write, it is
// saved as src/workflows/<name>.js in the project (discord.js JS projects only).
export const POST = handler(async (request, { params }) => {
    const { supabase, ownerId, project, workflow } = await ownedWorkflow(params, await requireStudioUser());
    const body = await readJson(request);
    const code = workflows.exportCode(workflow.graph, { name: workflow.name });
    if (code.error) throw new HttpError(422, code.error, { problems: code.problems });
    if (body?.write) {
        if (project.framework !== 'discordjs') throw new HttpError(422, 'Writing workflow code into the project is available for discord.js (JavaScript) projects. Download it instead.');
        const { error } = await supabase.from('studio_project_files').upsert({ project_id: project.id, owner_id: ownerId, path: code.path, content: code.content, updated_at: new Date().toISOString() }, { onConflict: 'project_id,path' });
        if (error) throw mapWriteError(error, 'free');
    }
    return json({ path: code.path, content: code.content, written: Boolean(body?.write) });
});
