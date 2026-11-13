import { handler, json, readJson, HttpError } from '@/lib/http';
import gen from '@/lib/studio/workflowGen';
import agents from '@/lib/studio/agents';
import market from '@/lib/studio/marketplace';
import secrets from '@/lib/studio/secrets';
import { claimQuota } from '@/lib/shared/quota';
import { completeChat } from '@/lib/studio/aiProvider';
import { runAgent } from '@/lib/studio/agentProviders';
import { createServiceClient } from '@/lib/supabase/server';
import { requireStudioUser, getOwnedProject, getPlan } from '@/lib/studio/server';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const since = () => new Date(Date.now() - 86400000).toISOString();

// POST { request, engine: 'zigbot' | 'anthropic' | 'openai', model? }
// "Describe the automation you want to create." The AI returns a workflow in
// the builder's validated schema (catalog blocks only, no code); it is laid
// out, validated and saved as a new DRAFT for the owner to edit on the
// canvas. Nothing is executed or activated. Usage is counted per engine.
export const POST = handler(async (request, { params }) => {
    const { projectId } = await params;
    const { supabase, ownerId } = await requireStudioUser();
    const project = await getOwnedProject(supabase, ownerId, projectId);
    const body = await readJson(request, 8192);
    const text = String(body?.request ?? '').trim();
    if (!text || text.length > gen.LIMITS.requestChars) throw new HttpError(422, `Describe the automation in 1-${gen.LIMITS.requestChars} characters.`, { fieldErrors: { request: 'Invalid request.' } });
    const engine = String(body?.engine ?? 'zigbot');
    const messages = gen.buildMessages(text);
    const db = createServiceClient();
    let answer; let runId = null; const started = Date.now();

    if (engine === 'zigbot') {
        const perDay = market.limitsFor(await getPlan(supabase, ownerId)).aiPerDay;
        const allowed = await claimQuota({
            limit: perDay,
            insert: async () => { const { error } = await supabase.from('studio_ai_usage').insert({ owner_id: ownerId, project_id: project.id }); if (error) throw new HttpError(503, 'AI storage is not set up yet: run the newest files in supabase/migrations.'); },
            count: async () => { const { count, error } = await supabase.from('studio_ai_usage').select('id', { count: 'exact', head: true }).eq('owner_id', ownerId).gte('created_at', since()); if (error) throw new Error('AI quota check failed.'); return count; }
        });
        if (!allowed) throw new HttpError(429, `You can use ZiGBoT AI ${perDay} times per day on your plan. Try again tomorrow, or use your own connected agent.`);
        answer = await completeChat(messages, { timeoutMs: 90_000, maxTokens: 6000 });
    } else if (agents.PROVIDERS[engine]) {
        const { data: stored } = await db.from('studio_agent_keys').select('provider, ciphertext, iv, tag, model').eq('owner_id', ownerId).eq('provider', engine).maybeSingle();
        if (!stored) throw new HttpError(422, 'Connect this agent first (AI creator page → Agent keys).', { code: 'no_key' });
        const resolved = agents.resolveModel(engine, body?.model || stored.model);
        if (resolved.error) throw new HttpError(422, resolved.error);
        const allowed = await claimQuota({
            limit: agents.LIMITS.runsPerDay,
            insert: async () => { const { data, error } = await db.from('studio_agent_runs').insert({ owner_id: ownerId, project_id: project.id, provider: engine, model: resolved.model }).select('id').single(); if (error) throw new HttpError(503, 'Agent storage is not set up yet: run the newest files in supabase/migrations.'); runId = data.id; },
            count: async () => { const { count, error } = await db.from('studio_agent_runs').select('id', { count: 'exact', head: true }).eq('owner_id', ownerId).gte('created_at', since()); if (error) throw new Error('Agent quota check failed.'); return count; }
        });
        const finish = (patch) => db.from('studio_agent_runs').update(patch).eq('id', runId).eq('owner_id', ownerId);
        if (!allowed) { await finish({ status: 'failed', error: 'daily limit' }); throw new HttpError(429, `You can run coding agents ${agents.LIMITS.runsPerDay} times per day.`); }
        try {
            let apiKey;
            try {
                apiKey = secrets.decryptSecret(stored, { key: process.env.STUDIO_SECRETS_KEY, aad: agents.keyAad(ownerId, engine) });
            } catch {
                throw new HttpError(422, 'Your saved key could not be read. Add it again.', { code: 'bad_key' });
            }
            const result = await runAgent({ providerId: engine, model: resolved.model, apiKey, messages, signal: request.signal });
            apiKey = null;
            answer = result.text;
            await finish({ status: 'done', input_tokens: result.usage.input, output_tokens: result.usage.output, duration_ms: Date.now() - started });
        } catch (error) {
            await finish({ status: error?.extra?.code === 'cancelled' ? 'cancelled' : 'failed', error: String(error?.message || 'failed').slice(0, 300), duration_ms: Date.now() - started });
            throw error;
        }
    } else {
        throw new HttpError(422, 'Pick ZiGBoT AI or one of your connected agents.');
    }

    const result = gen.parseGenerated(answer);
    if (result.error) throw new HttpError(422, result.error, { dropped: result.dropped || [] });
    const { data: created, error } = await supabase.from('studio_workflows').insert({ project_id: project.id, owner_id: ownerId, name: result.name, graph: result.graph }).select('id, name').single();
    if (error) throw /studio_workflow_limit/.test(error.message) ? new HttpError(403, 'This project already has 20 workflows. Delete one first.') : new Error(`Workflow save failed: ${error.message}`);
    return json({ workflow: created, problems: result.problems, dropped: result.dropped, engine }, 201);
});
