import { handler, json, readJson, HttpError } from '@/lib/http';
import secrets from '@/lib/studio/secrets';
import { createServiceClient } from '@/lib/supabase/server';
import { requireStudioUser, getOwnedProject } from '@/lib/studio/server';

import { getEffectivePlan } from '@/lib/studio/entitlementServer';
import market from '@/lib/studio/marketplace';

export const dynamic = 'force-dynamic';

// Encrypted environment variables for the owner's project (same storage and
// rules as the bot token: AES-256-GCM, unreachable from browsers, values
// never returned or logged; answers carry name + last 4 only). The bot
// token itself is managed by ../token (checked with Discord first).
const RESERVED = new Set(['DISCORD_TOKEN']);
const MAX_VALUE = 4096;

async function owned(params) {
    const { projectId } = await params;
    const session = await requireStudioUser();
    const { supabase, ownerId } = session;
    const project = await getOwnedProject(supabase, ownerId, projectId);
    return { project, ownerId, session, db: createServiceClient() };
}

export const GET = handler(async (_request, { params }) => {
    const { project, ownerId, db } = await owned(params);
    const { data, error } = await db.from('studio_secrets').select('name, last4, updated_at').eq('project_id', project.id).eq('owner_id', ownerId).order('name');
    if (error) throw new Error('Variable list failed.');
    return json({ variables: (data || []).map((v) => ({ name: v.name, configured: true, last4: v.last4, updatedAt: v.updated_at })) });
});

// PUT { name, value }
export const PUT = handler(async (request, { params }) => {
    const { project, ownerId, session, db } = await owned(params);
    const MAX_VARS = market.limitsFor(await getEffectivePlan(session)).envVars;
    if (!process.env.STUDIO_SECRETS_KEY) throw new HttpError(503, 'Variable storage is not set up on this server yet (STUDIO_SECRETS_KEY).');
    const body = await readJson(request, 8192);
    const name = String(body?.name ?? '').trim();
    const value = typeof body?.value === 'string' ? body.value : '';
    if (!secrets.ENV_NAME.test(name)) throw new HttpError(422, 'Names are 2-64 capital letters, digits or _, starting with a letter.', { fieldErrors: { name: 'Invalid name.' } });
    if (RESERVED.has(name)) throw new HttpError(422, 'Set the bot token on the Customize page (it is checked with Discord first).', { fieldErrors: { name: 'Reserved.' } });
    if (!value || value.length > MAX_VALUE) throw new HttpError(422, `Values are 1-${MAX_VALUE} characters.`, { fieldErrors: { value: 'Invalid value.' } });
    const { data: existing } = await db.from('studio_secrets').select('name').eq('project_id', project.id).eq('owner_id', ownerId);
    if (!(existing || []).some((v) => v.name === name) && (existing || []).length >= MAX_VARS) throw new HttpError(403, `Your plan allows ${MAX_VARS} variables per project${MAX_VARS < 50 ? '; Premium allows 50' : ''}.`);
    let sealed;
    try {
        sealed = secrets.encryptSecret(value, { key: process.env.STUDIO_SECRETS_KEY, aad: secrets.aadFor(project.id, name) });
    } catch {
        throw new HttpError(503, 'Variable storage is misconfigured on this server (STUDIO_SECRETS_KEY).');
    }
    const { error } = await db.from('studio_secrets').upsert({ project_id: project.id, owner_id: ownerId, name, ...sealed, meta: {}, updated_at: new Date().toISOString() }, { onConflict: 'project_id,name' });
    if (error) throw new Error('Variable save failed.');
    return json({ variable: { name, configured: true, last4: sealed.last4 } });
});

// DELETE { name }
export const DELETE = handler(async (request, { params }) => {
    const { project, ownerId, db } = await owned(params);
    const body = await readJson(request);
    const name = String(body?.name ?? '');
    if (!secrets.ENV_NAME.test(name) || RESERVED.has(name)) throw new HttpError(422, 'Invalid variable.');
    const { error } = await db.from('studio_secrets').delete().eq('project_id', project.id).eq('owner_id', ownerId).eq('name', name);
    if (error) throw new Error('Variable delete failed.');
    return json({ deleted: true });
});
