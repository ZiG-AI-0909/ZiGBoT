import { handler, json, readJson, HttpError } from '@/lib/http';
import ai from '@/lib/studio/aiCreator';
import { completeChat } from '@/lib/studio/aiProvider';
import { claimQuota } from '@/lib/shared/quota';
import { requireStudioUser, getOwnedProject } from '@/lib/studio/server';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const since = () => new Date(Date.now() - 86400000).toISOString();

// GET: this project's proposals (newest first) and today's remaining AI uses.
export const GET = handler(async (_request, { params }) => {
    const { projectId } = await params;
    const { supabase, ownerId } = await requireStudioUser();
    const project = await getOwnedProject(supabase, ownerId, projectId);
    const { data, error } = await supabase.from('studio_ai_proposals').select('*').eq('project_id', project.id).eq('owner_id', ownerId).order('created_at', { ascending: false }).limit(30);
    if (error) throw new HttpError(503, 'AI storage is not set up yet: run the newest files in supabase/migrations.');
    const { count } = await supabase.from('studio_ai_usage').select('id', { count: 'exact', head: true }).eq('owner_id', ownerId).gte('created_at', since());
    return json({ proposals: (data || []).map(ai.publicProposal), remaining: Math.max(0, ai.LIMITS.perDay - (count || 0)), limit: ai.LIMITS.perDay });
});

// POST { request }: ask the AI for a plan + changes. This NEVER writes project
// files: the result is stored as a pending proposal for the owner to approve.
export const POST = handler(async (request, { params }) => {
    const { projectId } = await params;
    const { supabase, ownerId } = await requireStudioUser();
    const project = await getOwnedProject(supabase, ownerId, projectId);
    const body = await readJson(request, 8192);
    const text = String(body?.request ?? '').trim();
    if (!text || text.length > ai.LIMITS.requestChars) throw new HttpError(422, `Describe the change in 1-${ai.LIMITS.requestChars} characters.`, { fieldErrors: { request: 'Invalid request.' } });

    const allowed = await claimQuota({
        limit: ai.LIMITS.perDay,
        insert: async () => {
            const { error } = await supabase.from('studio_ai_usage').insert({ owner_id: ownerId, project_id: project.id });
            if (error) throw new HttpError(503, 'AI storage is not set up yet: run the newest files in supabase/migrations.');
        },
        count: async () => {
            const { count, error } = await supabase.from('studio_ai_usage').select('id', { count: 'exact', head: true }).eq('owner_id', ownerId).gte('created_at', since());
            if (error) throw new Error('AI quota check failed.');
            return count;
        }
    });
    if (!allowed) throw new HttpError(429, `You can use the AI creator ${ai.LIMITS.perDay} times per day. Try again tomorrow.`);

    // Context: only THIS project's files (RLS + owner + project filters).
    const { data: files, error: filesError } = await supabase.from('studio_project_files').select('path, content').eq('project_id', project.id).eq('owner_id', ownerId).limit(1000);
    if (filesError) throw new Error('File read failed.');
    const answer = await completeChat(ai.buildMessages({ request: text, files: files || [], framework: project.framework }));
    const proposal = ai.parseProposal(answer, files || []);
    if (proposal.error) throw new HttpError(422, proposal.error, { rejected: proposal.rejected || [] });

    const { data, error } = await supabase.from('studio_ai_proposals').insert({
        project_id: project.id, owner_id: ownerId, request: text, plan: proposal.plan, changes: proposal.changes, rejected: proposal.rejected, status: 'pending'
    }).select('*').single();
    if (error) throw new Error(`Proposal save failed: ${error.message}`);
    return json({ proposal: ai.publicProposal(data) }, 201);
});
