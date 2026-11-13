import runner from '@/lib/studio/runner';
import { runnerHandler, requireRunner, readBody, reply } from '@/lib/studio/runnerServer';

export const dynamic = 'force-dynamic';

// POST { state?, version? } → { command: { id, action } | null, pollAfterMs }
// Heartbeat + the oldest queued command for this runner (marked "sent").
export const POST = runnerHandler(async (request) => {
    const { db, runner: r } = await requireRunner(request);
    const body = await readBody(request, 4096);
    const patch = { last_seen_at: new Date().toISOString() };
    if (runner.STATES.includes(body?.state)) patch.state = body.state;
    if (body?.version) patch.version = String(body.version).slice(0, 20);
    await db.from('studio_runners').update(patch).eq('id', r.id);

    const { data: next } = await db.from('studio_runner_commands').select('id, action').eq('runner_id', r.id).eq('status', 'queued').order('id').limit(1);
    let command = null;
    if (next?.length) {
        const { data: claimed } = await db.from('studio_runner_commands').update({ status: 'sent', updated_at: new Date().toISOString() }).eq('id', next[0].id).eq('status', 'queued').select('id, action');
        command = claimed?.[0] || null;
    }
    return reply({ command, pollAfterMs: command ? 1000 : 5000 });
});
