import { handler, json, readJson, HttpError } from '@/lib/http';
import runner from '@/lib/studio/runner';
import studio from '@/lib/studio/projects';
import { env } from '@/lib/env';
import { createServiceClient } from '@/lib/supabase/server';
import { requireStudioUser, getOwnedProject } from '@/lib/studio/server';

import { getEffectivePlan } from '@/lib/studio/entitlementServer';
import market from '@/lib/studio/marketplace';

export const dynamic = 'force-dynamic';

// GET: this project's self-hosted runners, recent commands and log lines.
export const GET = handler(async (_request, { params }) => {
    const { projectId } = await params;
    const { supabase, ownerId } = await requireStudioUser();
    const project = await getOwnedProject(supabase, ownerId, projectId);
    const { data: runners, error } = await supabase.from('studio_runners').select('id, project_id, owner_id, name, status, state, platform, version, last_seen_at, created_at').eq('project_id', project.id).eq('owner_id', ownerId).neq('status', 'revoked').order('created_at');
    if (error) throw new HttpError(503, 'Runner storage is not set up yet: run the newest files in supabase/migrations.');
    const ids = (runners || []).map((r) => r.id);
    let commands = []; let logs = [];
    if (ids.length) {
        const [c, l] = await Promise.all([
            supabase.from('studio_runner_commands').select('id, runner_id, action, status, message, created_at, updated_at').in('runner_id', ids).eq('owner_id', ownerId).order('id', { ascending: false }).limit(30),
            supabase.from('studio_runner_logs').select('id, runner_id, level, line, created_at').in('runner_id', ids).eq('owner_id', ownerId).order('id', { ascending: false }).limit(200)
        ]);
        commands = c.data || []; logs = (l.data || []).reverse();
    }
    return json({ runners: (runners || []).map((r) => runner.publicRunner(r)), commands, logs, siteUrl: env.siteUrl || null });
});

// POST { action: 'add', name } | { action: 'command', runnerId, command } | { action: 'remove', runnerId }
export const POST = handler(async (request, { params }) => {
    const { projectId } = await params;
    const session = await requireStudioUser();
    const { supabase, ownerId } = session;
    const project = await getOwnedProject(supabase, ownerId, projectId);
    const body = await readJson(request);
    const db = createServiceClient();

    if (body?.action === 'add') {
        const { count } = await db.from('studio_runners').select('id', { count: 'exact', head: true }).eq('project_id', project.id).eq('owner_id', ownerId).neq('status', 'revoked');
        const maxRunners = market.limitsFor(await getEffectivePlan(session)).runners;
        if ((count || 0) >= maxRunners) throw new HttpError(403, `Your plan allows ${maxRunners} runner(s) per project. Remove one first${maxRunners < 3 ? ', or upgrade to Premium for more' : ''}.`, { code: 'plan_limit' });
        const code = runner.newPairingCode();
        const expiresAt = new Date(Date.now() + runner.LIMITS.pairingMinutes * 60_000).toISOString();
        const { data, error } = await db.from('studio_runners').insert({ project_id: project.id, owner_id: ownerId, name: runner.cleanName(body.name), status: 'pairing', pairing_code_hash: runner.hashPairingCode(code), pairing_expires_at: expiresAt }).select('id, name').single();
        if (error) throw new Error('Runner create failed.');
        // The code is shown once; only its hash is stored.
        return json({ runner: data, pairingCode: code, expiresAt }, 201);
    }

    if (!studio.UUID.test(String(body?.runnerId || ''))) throw new HttpError(404, 'Runner not found.');
    const { data: r } = await db.from('studio_runners').select('id, status').eq('id', body.runnerId).eq('project_id', project.id).eq('owner_id', ownerId).maybeSingle();
    if (!r || r.status === 'revoked') throw new HttpError(404, 'Runner not found.');

    if (body.action === 'remove') {
        // Revoking clears the token: the machine can no longer fetch code or secrets.
        const { error } = await db.from('studio_runners').update({ status: 'revoked', token_hash: null, pairing_code_hash: null }).eq('id', r.id).eq('owner_id', ownerId);
        if (error) throw new Error('Runner remove failed.');
        await db.from('studio_runner_commands').update({ status: 'cancelled', updated_at: new Date().toISOString() }).eq('runner_id', r.id).in('status', ['queued', 'sent']);
        return json({ removed: true });
    }

    if (body.action === 'command') {
        if (!runner.ACTIONS.includes(body.command)) throw new HttpError(422, 'Unknown command.');
        if (r.status !== 'paired') throw new HttpError(409, 'Pair the runner first.');
        const { count } = await db.from('studio_runner_commands').select('id', { count: 'exact', head: true }).eq('runner_id', r.id).eq('status', 'queued');
        if ((count || 0) >= runner.LIMITS.queuedCommands) throw new HttpError(429, 'Too many commands waiting. Is the runner online?');
        const { data, error } = await db.from('studio_runner_commands').insert({ runner_id: r.id, project_id: project.id, owner_id: ownerId, action: body.command }).select('id, action, status, created_at').single();
        if (error) throw new Error('Command failed.');
        return json({ command: data }, 201);
    }
    throw new HttpError(422, 'Unknown action.');
});
