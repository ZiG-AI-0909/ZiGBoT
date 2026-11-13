import { handler, json, readJson, HttpError } from '@/lib/http';
import agents from '@/lib/studio/agents';
import secrets from '@/lib/studio/secrets';
import { createServiceClient } from '@/lib/supabase/server';
import { requireStudioUser } from '@/lib/studio/server';

export const dynamic = 'force-dynamic';

// The signed-in user's own agent API keys. Sealed with AES-256-GCM on the
// server, bound to the user + provider; never returned (only "configured"
// and the last 4 characters), never logged, unreachable from browsers.
const aad = agents.keyAad;

export const GET = handler(async () => {
    const { ownerId } = await requireStudioUser();
    const { data } = await createServiceClient().from('studio_agent_keys').select('provider, last4, model, updated_at').eq('owner_id', ownerId);
    const byProvider = Object.fromEntries((data || []).map((k) => [k.provider, k]));
    return json({
        providers: Object.values(agents.PROVIDERS).map((p) => ({
            id: p.id, label: p.label, keyHint: p.keyHint, models: p.models, defaultModel: p.defaultModel,
            configured: Boolean(byProvider[p.id]), last4: byProvider[p.id]?.last4 || null, model: byProvider[p.id]?.model || null
        })),
        notAvailable: agents.NOT_AVAILABLE,
        projectTypes: agents.PROJECT_TYPES,
        limits: agents.LIMITS
    });
});

// PUT { provider, apiKey, model? }
export const PUT = handler(async (request) => {
    const { ownerId } = await requireStudioUser();
    if (!process.env.STUDIO_SECRETS_KEY) throw new HttpError(503, 'Key storage is not set up on this server yet (STUDIO_SECRETS_KEY).');
    const body = await readJson(request, 4096);
    const provider = String(body?.provider ?? '');
    const keyError = agents.validateKey(provider, body?.apiKey);
    if (keyError) throw new HttpError(422, keyError, { fieldErrors: { apiKey: keyError } });
    let model = null;
    if (body?.model) {
        const resolved = agents.resolveModel(provider, body.model);
        if (resolved.error) throw new HttpError(422, resolved.error, { fieldErrors: { model: resolved.error } });
        model = resolved.model;
    }
    let sealed;
    try {
        sealed = secrets.encryptSecret(String(body.apiKey).trim(), { key: process.env.STUDIO_SECRETS_KEY, aad: aad(ownerId, provider) });
    } catch {
        throw new HttpError(503, 'Key storage is misconfigured on this server (STUDIO_SECRETS_KEY).');
    }
    const { error } = await createServiceClient().from('studio_agent_keys').upsert({ owner_id: ownerId, provider, ciphertext: sealed.ciphertext, iv: sealed.iv, tag: sealed.tag, last4: sealed.last4, model, updated_at: new Date().toISOString() }, { onConflict: 'owner_id,provider' });
    if (error) throw new HttpError(503, 'Agent key storage is not set up yet: run the newest files in supabase/migrations.');
    return json({ provider, configured: true, last4: sealed.last4, model });
});

// DELETE { provider }
export const DELETE = handler(async (request) => {
    const { ownerId } = await requireStudioUser();
    const body = await readJson(request);
    if (!agents.PROVIDERS[body?.provider]) throw new HttpError(422, 'Unknown agent.');
    await createServiceClient().from('studio_agent_keys').delete().eq('owner_id', ownerId).eq('provider', body.provider);
    return json({ removed: true });
});
