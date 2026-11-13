import { handler, json, readJson, HttpError } from '@/lib/http';
import agents from '@/lib/studio/agents';
import ai from '@/lib/studio/aiCreator';
import checks from '@/lib/studio/checks';
import secrets from '@/lib/studio/secrets';
import { claimQuota } from '@/lib/shared/quota';
import { createServiceClient } from '@/lib/supabase/server';
import { runAgent } from '@/lib/studio/agentProviders';
import { requireStudioUser, getOwnedProject } from '@/lib/studio/server';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const since = () => new Date(Date.now() - 86400000).toISOString();

// GET: this project's recent agent runs (usage tracking).
export const GET = handler(async (_request, { params }) => {
    const { projectId } = await params;
    const { supabase, ownerId } = await requireStudioUser();
    const project = await getOwnedProject(supabase, ownerId, projectId);
    const { data } = await supabase.from('studio_agent_runs').select('id, provider, model, status, error, input_tokens, output_tokens, duration_ms, proposal_id, created_at').eq('project_id', project.id).eq('owner_id', ownerId).order('id', { ascending: false }).limit(20);
    return json({ runs: data || [] });
});

// POST { provider, model?, request, projectType }
// Runs the owner's chosen agent with THEIR key on THIS project's files only,
// then stores the result as a pending proposal (diffs + static check
// results). Nothing is written to the project here and nothing is executed.
// Cancelling the request (closing the tab / Cancel) aborts the agent call.
export const POST = handler(async (request, { params }) => {
    const { projectId } = await params;
    const { supabase, ownerId } = await requireStudioUser();
    const project = await getOwnedProject(supabase, ownerId, projectId);
    const body = await readJson(request, 8192);
    const text = String(body?.request ?? '').trim();
    if (!text || text.length > ai.LIMITS.requestChars) throw new HttpError(422, `Describe what to build in 1-${ai.LIMITS.requestChars} characters.`, { fieldErrors: { request: 'Invalid request.' } });
    if (!agents.PROJECT_TYPES.some((t) => t.id === body?.projectType)) throw new HttpError(422, 'Pick a project type.');

    const db = createServiceClient();
    const { data: stored } = await db.from('studio_agent_keys').select('provider, ciphertext, iv, tag, last4, model').eq('owner_id', ownerId).eq('provider', String(body?.provider ?? '')).maybeSingle();
    if (!stored) throw new HttpError(422, 'Connect this agent first: add your API key in Agent keys.', { code: 'no_key' });
    const resolved = agents.resolveModel(stored.provider, body?.model || stored.model);
    if (resolved.error) throw new HttpError(422, resolved.error);

    // Per-user daily cap (claimed first: the run row is the claim).
    let runId = null;
    const allowed = await claimQuota({
        limit: agents.LIMITS.runsPerDay,
        insert: async () => {
            const { data, error } = await db.from('studio_agent_runs').insert({ owner_id: ownerId, project_id: project.id, provider: stored.provider, model: resolved.model }).select('id').single();
            if (error) throw new HttpError(503, 'Agent storage is not set up yet: run the newest files in supabase/migrations.');
            runId = data.id;
        },
        count: async () => {
            const { count, error } = await db.from('studio_agent_runs').select('id', { count: 'exact', head: true }).eq('owner_id', ownerId).gte('created_at', since());
            if (error) throw new Error('Agent quota check failed.');
            return count;
        }
    });
    const finish = (patch) => db.from('studio_agent_runs').update(patch).eq('id', runId).eq('owner_id', ownerId);
    if (!allowed) { await finish({ status: 'failed', error: 'daily limit' }); throw new HttpError(429, `You can run coding agents ${agents.LIMITS.runsPerDay} times per day. Try again tomorrow.`); }

    const started = Date.now();
    try {
        let apiKey;
        try {
            apiKey = secrets.decryptSecret(stored, { key: process.env.STUDIO_SECRETS_KEY, aad: agents.keyAad(ownerId, stored.provider) });
        } catch {
            throw new HttpError(422, 'Your saved key could not be read. Add it again in Agent keys.', { code: 'bad_key' });
        }
        const { data: files, error: filesError } = await supabase.from('studio_project_files').select('path, content').eq('project_id', project.id).eq('owner_id', ownerId).limit(1000);
        if (filesError) throw new Error('File read failed.');
        const messages = agents.buildAgentMessages({ request: text, files: files || [], framework: project.framework, specialization: project.specialization, projectType: body.projectType });
        const result = await runAgent({ providerId: stored.provider, model: resolved.model, apiKey, messages, signal: request.signal });
        apiKey = null;

        const proposal = ai.parseProposal(result.text, files || []);
        if (proposal.error) throw new HttpError(422, proposal.error, { rejected: proposal.rejected || [] });
        // "Test and debug": static checks on the project as it WOULD be after approval (nothing runs).
        const after = new Map((files || []).map((f) => [f.path, f.content]));
        for (const c of proposal.changes) { if (c.action === 'delete') after.delete(c.path); else after.set(c.path, c.content); }
        const merged = [...after].map(([path, content]) => ({ path, content }));
        const checkResults = ['syntax', 'lint'].map((id) => checks.runCheck(id, merged, project.framework)).map((r) => ({ id: r.id, label: r.label, ok: r.ok, problems: r.problems.slice(0, 30) }));

        const { data: row, error } = await supabase.from('studio_ai_proposals').insert({
            project_id: project.id, owner_id: ownerId, request: text, plan: proposal.plan, changes: proposal.changes, rejected: proposal.rejected, status: 'pending', agent: stored.provider, model: result.servedBy.slice(0, 64)
        }).select('*').single();
        if (error) throw new Error(`Proposal save failed: ${error.message}`);
        await finish({ status: 'done', input_tokens: result.usage.input, output_tokens: result.usage.output, duration_ms: Date.now() - started, proposal_id: row.id });
        return json({ proposal: ai.publicProposal(row), checks: checkResults, usage: result.usage, model: result.servedBy }, 201);
    } catch (error) {
        const cancelled = error?.extra?.code === 'cancelled';
        await finish({ status: cancelled ? 'cancelled' : 'failed', error: String(error?.message || 'failed').slice(0, 300), duration_ms: Date.now() - started });
        throw error;
    }
});
