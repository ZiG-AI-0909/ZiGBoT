import { after } from 'next/server';
import botList from '@/lib/shared/botList';
import { sendDirectMessage } from '@/lib/discord';
import { createServiceClient } from '@/lib/supabase/server';
import { env } from '@/lib/env';

export const dynamic = 'force-dynamic';

// discordbotlist.com -> us, once per upvote. Not wrapped in the same-origin
// handler (the bot list is the caller); the Authorization header must equal
// DBL_WEBHOOK_SECRET. The voter gets a thank-you DM after the response.
//
// The "Test webhook" button on the bot's edit page posts from the owner's
// BROWSER (Origin: https://discordbotlist.com), so that origin may call this
// route. Such a request only checks the secret: real votes come from
// discordbotlist's servers, which send no Origin, so a test is never logged
// as a vote and never DMs anyone.
const TEST_ORIGIN = 'https://discordbotlist.com';
// The test also sends X-DBL-Signature ("<secret> <ms>"), and their HTTP
// client may add more; allow whatever header names it asks for (the secret
// is still required).
const allowedHeaders = (request) => {
    const asked = String(request.headers.get('access-control-request-headers') || '')
        .split(',').map((h) => h.trim().toLowerCase()).filter((h) => /^[a-z0-9-]{1,64}$/.test(h)).slice(0, 20);
    return [...new Set(['authorization', 'content-type', 'x-dbl-signature', ...asked])].join(', ');
};
const cors = (request) => (request.headers.get('origin') === TEST_ORIGIN ? {
    'Access-Control-Allow-Origin': TEST_ORIGIN,
    'Access-Control-Allow-Methods': 'POST',
    'Access-Control-Allow-Headers': allowedHeaders(request),
    'Access-Control-Max-Age': '600',
    Vary: 'Origin, Access-Control-Request-Headers'
} : {});
const reply = (request, status) => new Response(null, { status, headers: { 'Cache-Control': 'no-store', ...cors(request) } });

export function OPTIONS(request) {
    return reply(request, 204);
}

export async function POST(request) {
    const secret = env.dblWebhookSecret;
    if (!secret) return reply(request, 503);
    if (!botList.verifyVoteSecret(request.headers.get('authorization') || '', secret)) return reply(request, 401);
    if (request.headers.get('origin') === TEST_ORIGIN) return reply(request, 204);

    const raw = await request.text();
    if (raw.length > 16 * 1024) return reply(request, 413);
    let body;
    try {
        body = JSON.parse(raw);
    } catch {
        return reply(request, 400);
    }
    const vote = botList.parseVote(body);
    if (!vote) return reply(request, 400);

    const { error } = await createServiceClient().from('zb_votes').insert(vote);
    if (error) {
        console.error('[vote webhook] insert failed:', error.message);
        return reply(request, 500);
    }
    after(() => sendDirectMessage(vote.user_discord_id, botList.VOTE_THANKS).catch((e) => console.error('[vote webhook] thank-you DM failed:', e?.status || e?.message)));
    return reply(request, 204);
}
