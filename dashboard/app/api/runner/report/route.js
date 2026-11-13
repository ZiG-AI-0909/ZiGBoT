import { HttpError } from '@/lib/http';
import runner from '@/lib/studio/runner';
import { runnerHandler, requireRunner, readBody, reply } from '@/lib/studio/runnerServer';

export const dynamic = 'force-dynamic';

// POST { commandId?, status?, message?, state?, logs?: [{ level, line }] }
// Command results, process state and log lines from the runner. Token-like
// strings in logs are redacted before they are stored.
export const POST = runnerHandler(async (request) => {
    const { db, runner: r } = await requireRunner(request);
    const parsed = runner.validateReport(await readBody(request, 128 * 1024));
    if (parsed.error) throw new HttpError(422, parsed.error);
    const v = parsed.value;
    const now = new Date().toISOString();
    if (v.commandId) {
        await db.from('studio_runner_commands').update({ status: v.status, message: v.message || null, updated_at: now }).eq('id', v.commandId).eq('runner_id', r.id).eq('status', 'sent');
    }
    await db.from('studio_runners').update({ last_seen_at: now, ...(v.state ? { state: v.state } : {}), ...(v.version ? { version: v.version } : {}) }).eq('id', r.id);
    if (v.logs.length) await db.from('studio_runner_logs').insert(v.logs.map((l) => ({ runner_id: r.id, owner_id: r.owner_id, level: l.level, line: l.line })));
    return reply({ ok: true });
});
