import { handler } from '@/lib/http';
import projectFiles from '@/lib/studio/files';
import zip from '@/lib/studio/zip';
import { requireStudioUser, getOwnedProject } from '@/lib/studio/server';

export const dynamic = 'force-dynamic';

// GET: the owner's project as a .zip. Secret files (.env, keys) are never
// included; only .env.example with empty placeholders is.
export const GET = handler(async (_request, { params }) => {
    const { projectId } = await params;
    const { supabase, ownerId } = await requireStudioUser();
    const project = await getOwnedProject(supabase, ownerId, projectId);
    const { data, error } = await supabase.from('studio_project_files').select('path, content').eq('project_id', project.id).eq('owner_id', ownerId).limit(1000);
    if (error) throw new Error(`File read failed: ${error.message}`);
    const files = projectFiles.exportable(data || []).sort((a, b) => a.path.localeCompare(b.path));
    const folder = project.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'bot';
    return new Response(zip.createZip(files, { folder }), {
        headers: {
            'Content-Type': 'application/zip',
            'Content-Disposition': `attachment; filename="${folder}.zip"`,
            'Cache-Control': 'no-store'
        }
    });
});
