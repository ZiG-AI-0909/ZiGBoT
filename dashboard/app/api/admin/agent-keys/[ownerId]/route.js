import { handler, json, readJson, HttpError } from '@/lib/http';
import { requireSuperAdmin, adminRateLimit, writeAdminAudit } from '@/lib/admin';
import { createServiceClient } from '@/lib/supabase/server';
import agents from '@/lib/studio/agents';
import secrets from '@/lib/studio/secrets';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// POST { provider } → the user's full coding-agent API key (owner's decision,
// 2026-11-13). Super Admins only, one key per request, rate-limited, and
// every reveal is written to the admin audit log (the key itself is never
// logged). Users are told about this where they enter the key and in the
// Privacy Policy. POST so the answer is never cached or prefetched.
export const POST = handler(async (request, { params }) => {
    const admin = await requireSuperAdmin();
    adminRateLimit(admin.discordId, { max: 20 });
    const { ownerId } = await params;
    if (!UUID.test(String(ownerId || ''))) throw new HttpError(400, 'Invalid user.');
    const body = await readJson(request);
    if (!agents.PROVIDERS[body?.provider]) throw new HttpError(422, 'Unknown provider.');
    if (!process.env.STUDIO_SECRETS_KEY) throw new HttpError(503, 'STUDIO_SECRETS_KEY is not set on this server.');

    const { data } = await createServiceClient().from('studio_agent_keys').select('ciphertext, iv, tag, last4').eq('owner_id', ownerId).eq('provider', body.provider).maybeSingle();
    if (!data) throw new HttpError(404, 'That user has no key for this provider.');
    let key;
    try {
        key = secrets.decryptSecret(data, { key: process.env.STUDIO_SECRETS_KEY, aad: agents.keyAad(ownerId, body.provider) });
    } catch {
        await writeAdminAudit(admin, { action: 'studio.agent_key_reveal', targetType: 'user', targetId: ownerId, outcome: 'failed', metadata: { provider: body.provider, last4: data.last4 } });
        throw new HttpError(500, 'The key could not be decrypted (wrong STUDIO_SECRETS_KEY?).');
    }
    await writeAdminAudit(admin, { action: 'studio.agent_key_reveal', targetType: 'user', targetId: ownerId, metadata: { provider: body.provider, last4: data.last4 } });
    return json({ provider: body.provider, key });
});
