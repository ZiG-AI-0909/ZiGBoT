import { HttpError } from '@/lib/http';
import runner from '@/lib/studio/runner';
import secrets from '@/lib/studio/secrets';
import { runnerHandler, requireRunner, reply } from '@/lib/studio/runnerServer';

export const dynamic = 'force-dynamic';

// GET ?command=<id> → the deploy bundle (files + env + start commands).
// Only for this runner's own deploy command that is currently "sent", so a
// leaked token cannot pull code or secrets at will. Secret values are
// decrypted here for the owner's own machine and never logged.
export const GET = runnerHandler(async (request) => {
    const { db, runner: r } = await requireRunner(request);
    const id = new URL(request.url).searchParams.get('command') || '';
    if (!/^\d{1,18}$/.test(id)) throw new HttpError(400, 'Missing command id.');
    const { data: cmd } = await db.from('studio_runner_commands').select('id, action, status').eq('id', Number(id)).eq('runner_id', r.id).maybeSingle();
    if (!cmd || cmd.action !== 'deploy' || cmd.status !== 'sent') throw new HttpError(409, 'No deploy in progress for this runner.');

    const [{ data: project }, { data: files, error: filesError }, { data: sealed }] = await Promise.all([
        db.from('studio_projects').select('id, name, framework').eq('id', r.project_id).eq('owner_id', r.owner_id).maybeSingle(),
        db.from('studio_project_files').select('path, content').eq('project_id', r.project_id).eq('owner_id', r.owner_id).limit(1000),
        db.from('studio_secrets').select('name, ciphertext, iv, tag').eq('project_id', r.project_id).eq('owner_id', r.owner_id)
    ]);
    if (!project || filesError) throw new HttpError(404, 'Project not found.');
    const env = {};
    for (const s of sealed || []) {
        try { env[s.name] = secrets.decryptSecret(s, { key: process.env.STUDIO_SECRETS_KEY, aad: secrets.aadFor(project.id, s.name) }); } catch { /* skip unreadable, never log values */ }
    }
    return reply(runner.buildBundle({ project, files: files || [], env }));
});
