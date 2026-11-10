import { after } from 'next/server';
import webhook from '@/lib/shared/discordWebhook';
import { sendDirectMessage } from '@/lib/discord';
import { createServiceClient } from '@/lib/supabase/server';
import { env } from '@/lib/env';

export const dynamic = 'force-dynamic';

// Discord -> us (Developer Portal -> Webhooks -> Endpoint URL). Not wrapped
// in the same-origin handler (Discord is the caller); every delivery must
// carry a valid Ed25519 signature for OUR application's public key, or it
// is refused. Discord expects a 204 within 3 seconds, so the creator's DM
// is sent after the response.
const empty = (status) => new Response(null, { status, headers: { 'Cache-Control': 'no-store' } });

export async function POST(request) {
    const publicKey = env.discordPublicKey;
    if (!publicKey) return empty(503);

    const raw = await request.text();
    if (raw.length > 64 * 1024) return empty(413);
    const ok = webhook.verifyDiscordSignature(raw, request.headers.get('x-signature-ed25519'), request.headers.get('x-signature-timestamp'), publicKey);
    if (!ok) return empty(401);

    let body;
    try {
        body = JSON.parse(raw);
    } catch {
        return empty(400);
    }
    // PING: Discord checking the endpoint when it is saved in the portal.
    if (body?.type === 0) return empty(204);

    const row = webhook.parseWebhookEvent(body);
    if (!row) return empty(204);

    const { error } = await createServiceClient().from('zb_app_events').insert(row);
    if (error) {
        // Non-2xx makes Discord retry later, which is what we want on a transient failure.
        console.error('[discord webhook] insert failed:', error.message);
        return empty(500);
    }

    const creator = env.botCreatorId;
    const message = webhook.describeEvent(row);
    if (/^\d{17,20}$/.test(creator) && message) {
        after(() => sendDirectMessage(creator, message).catch((e) => console.error('[discord webhook] creator DM failed:', e?.status || e?.message)));
    }
    return empty(204);
}
