import { HttpError } from '@/lib/http';
import runner from '@/lib/studio/runner';
import { createServiceClient } from '@/lib/supabase/server';
import { runnerHandler, readBody, reply } from '@/lib/studio/runnerServer';

export const dynamic = 'force-dynamic';

// POST { code, platform?, version? } → { token, runnerId, project }
// Exchanges a one-time pairing code (15 minutes) for the runner token. The
// token is returned exactly once; only its hash is stored. A code works once.
export const POST = runnerHandler(async (request) => {
    const body = await readBody(request, 4096);
    const code = runner.normalizeCode(body?.code);
    if (code.length !== 8) throw new HttpError(400, 'Pairing codes look like ABCD-EFGH.');
    const db = createServiceClient();
    const token = runner.newRunnerToken();
    const now = new Date().toISOString();
    // Atomic claim: only a row still in 'pairing' with this code and not expired.
    const { data, error } = await db.from('studio_runners')
        .update({ status: 'paired', token_hash: runner.hashRunnerToken(token), pairing_code_hash: null, pairing_expires_at: null, platform: String(body?.platform ?? '').slice(0, 60) || null, version: String(body?.version ?? '').slice(0, 20) || null, last_seen_at: now })
        .eq('pairing_code_hash', runner.hashPairingCode(code)).eq('status', 'pairing').gt('pairing_expires_at', now)
        .select('id, project_id, name');
    if (error) throw new Error('Pairing failed.');
    if (!data?.length) throw new HttpError(404, 'That code is wrong, already used or expired. Create a new one on the Deployments page.');
    const { data: project } = await db.from('studio_projects').select('id, name, framework').eq('id', data[0].project_id).maybeSingle();
    return reply({ token, runnerId: data[0].id, name: data[0].name, project });
});
