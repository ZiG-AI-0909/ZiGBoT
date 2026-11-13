import { handler, json, readJson, HttpError } from '@/lib/http';
import ai from '@/lib/studio/aiCreator';
import studio from '@/lib/studio/projects';
import { requireStudioUser, getOwnedProject, mapWriteError } from '@/lib/studio/server';

export const dynamic = 'force-dynamic';

// POST { decision: 'approve' | 'reject' }: the owner's explicit decision.
// Approve writes the proposal's checked changes (snapshotting each file
// first) only if none of the files changed since the proposal was made.
// Nothing is deployed.
export const POST = handler(async (request, { params }) => {
    const { projectId, proposalId } = await params;
    const { supabase, ownerId } = await requireStudioUser();
    const project = await getOwnedProject(supabase, ownerId, projectId);
    if (!studio.UUID.test(String(proposalId || ''))) throw new HttpError(404, 'Proposal not found.');
    const body = await readJson(request);
    const decision = body?.decision;
    if (decision !== 'approve' && decision !== 'reject') throw new HttpError(422, 'Choose approve or reject.');

    const { data: row, error } = await supabase.from('studio_ai_proposals').select('*').eq('id', proposalId).eq('project_id', project.id).eq('owner_id', ownerId).maybeSingle();
    if (error) throw new Error(`Proposal read failed: ${error.message}`);
    if (!row) throw new HttpError(404, 'Proposal not found.');
    if (row.status !== 'pending') throw new HttpError(409, `This proposal was already ${row.status}.`);

    // Claim the decision first (only one request can move it out of pending).
    const { data: claimed, error: claimError } = await supabase.from('studio_ai_proposals')
        .update({ status: decision === 'approve' ? 'approved' : 'rejected', decided_at: new Date().toISOString() })
        .eq('id', row.id).eq('owner_id', ownerId).eq('status', 'pending').select('id');
    if (claimError) throw new Error(`Proposal update failed: ${claimError.message}`);
    if (!claimed?.length) throw new HttpError(409, 'This proposal was already decided.');
    if (decision === 'reject') return json({ status: 'rejected' });

    const revert = () => supabase.from('studio_ai_proposals').update({ status: 'pending', decided_at: null }).eq('id', row.id).eq('owner_id', ownerId);
    const files = () => supabase.from('studio_project_files').select('path, content').eq('project_id', project.id).eq('owner_id', ownerId);
    const { data: current, error: readError } = await files().limit(1000);
    if (readError) { await revert(); throw new Error('File read failed.'); }
    const applied = ai.planApply(row, current || []);
    if (applied.error) { await revert(); throw new HttpError(409, applied.error, { conflicts: applied.conflicts || [] }); }

    const byPath = new Map((current || []).map((f) => [f.path, f.content]));
    const snapshots = [...applied.writes.map((w) => w.path), ...applied.deletes].filter((p) => byPath.has(p)).map((path) => ({ project_id: project.id, owner_id: ownerId, path, content: byPath.get(path) }));
    if (snapshots.length) {
        const { error: snapError } = await supabase.from('studio_file_versions').insert(snapshots);
        if (snapError) { await revert(); throw mapWriteError(snapError, 'free'); }
    }
    if (applied.writes.length) {
        const now = new Date().toISOString();
        const { error: writeError } = await supabase.from('studio_project_files').upsert(applied.writes.map((w) => ({ project_id: project.id, owner_id: ownerId, path: w.path, content: w.content, updated_at: now })), { onConflict: 'project_id,path' });
        if (writeError) { await revert(); throw mapWriteError(writeError, 'free'); }
    }
    for (const path of applied.deletes) {
        const { error: delError } = await supabase.from('studio_project_files').delete().eq('project_id', project.id).eq('owner_id', ownerId).eq('path', path);
        if (delError) throw new Error(`Delete of ${path} failed.`);
    }
    return json({ status: 'approved', written: applied.writes.map((w) => w.path), deleted: applied.deletes });
});
