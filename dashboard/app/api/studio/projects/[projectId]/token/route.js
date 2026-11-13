import { handler, json, readJson, HttpError } from '@/lib/http';
import secrets from '@/lib/studio/secrets';
import { checkBotToken } from '@/lib/studio/discordToken';
import { createServiceClient } from '@/lib/supabase/server';
import { requireStudioUser, getOwnedProject } from '@/lib/studio/server';

export const dynamic = 'force-dynamic';

// The bot token: checked with Discord GET /users/@me, stored AES-256-GCM
// encrypted (STUDIO_SECRETS_KEY), and NEVER returned: answers carry only
// "configured", the last 4 characters and the bot's public name/id.
// studio_secrets is unreachable from browsers; the service role is used
// only after the owner check.
const NAME = 'DISCORD_TOKEN';
const recentChecks = new Map(); // owner -> [timestamps]: max 5 token checks a minute

function allowCheck(ownerId) {
    const now = Date.now();
    const list = (recentChecks.get(ownerId) || []).filter((t) => now - t < 60_000);
    if (list.length >= 5) return false;
    list.push(now);
    recentChecks.set(ownerId, list);
    return true;
}

async function readStatus(projectId, ownerId) {
    const { data, error } = await createServiceClient().from('studio_secrets').select('last4, meta, updated_at').eq('project_id', projectId).eq('owner_id', ownerId).eq('name', NAME).maybeSingle();
    if (error) throw new Error('Secret read failed.');
    return secrets.secretStatus(data);
}

export const GET = handler(async (_request, { params }) => {
    const { projectId } = await params;
    const { supabase, ownerId } = await requireStudioUser();
    const project = await getOwnedProject(supabase, ownerId, projectId);
    return json({ token: await readStatus(project.id, ownerId) });
});

// POST { token }
export const POST = handler(async (request, { params }) => {
    const { projectId } = await params;
    const { supabase, ownerId } = await requireStudioUser();
    const project = await getOwnedProject(supabase, ownerId, projectId);
    if (!process.env.STUDIO_SECRETS_KEY) throw new HttpError(503, 'Token storage is not set up on this server yet (STUDIO_SECRETS_KEY).');
    if (!allowCheck(ownerId)) throw new HttpError(429, 'Too many token checks. Wait a minute.');
    const body = await readJson(request, 4096);
    const token = typeof body?.token === 'string' ? body.token.trim() : '';
    const check = await checkBotToken(token);
    if (!check.ok) throw new HttpError(check.retry ? 502 : 422, check.reason, { fieldErrors: { token: check.reason } });
    let sealed;
    try {
        sealed = secrets.encryptSecret(token, { key: process.env.STUDIO_SECRETS_KEY, aad: secrets.aadFor(project.id, NAME) });
    } catch {
        throw new HttpError(503, 'Token storage is misconfigured on this server (STUDIO_SECRETS_KEY).');
    }
    const { error } = await createServiceClient().from('studio_secrets').upsert({
        project_id: project.id, owner_id: ownerId, name: NAME, ...sealed,
        meta: { botId: check.bot.id, botUsername: check.bot.username }, updated_at: new Date().toISOString()
    }, { onConflict: 'project_id,name' });
    if (error) throw new Error('Secret save failed.');
    return json({ token: { configured: true, last4: sealed.last4, meta: { botId: check.bot.id, botUsername: check.bot.username } } });
});

export const DELETE = handler(async (_request, { params }) => {
    const { projectId } = await params;
    const { supabase, ownerId } = await requireStudioUser();
    const project = await getOwnedProject(supabase, ownerId, projectId);
    const { error } = await createServiceClient().from('studio_secrets').delete().eq('project_id', project.id).eq('owner_id', ownerId).eq('name', NAME);
    if (error) throw new Error('Secret delete failed.');
    return json({ token: { configured: false } });
});
