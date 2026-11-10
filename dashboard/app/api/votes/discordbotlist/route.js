import { after } from 'next/server';
import botList from '@/lib/shared/botList';
import { sendDirectMessage } from '@/lib/discord';
import { createServiceClient } from '@/lib/supabase/server';
import { env } from '@/lib/env';

export const dynamic = 'force-dynamic';

// discordbotlist.com -> us, once per upvote. Not wrapped in the same-origin
// handler (the bot list is the caller); the Authorization header must equal
// DBL_WEBHOOK_SECRET. The voter gets a thank-you DM after the response.
const reply = (status) => new Response(null, { status, headers: { 'Cache-Control': 'no-store' } });

export async function POST(request) {
    const secret = env.dblWebhookSecret;
    if (!secret) return reply(503);
    if (!botList.verifyVoteSecret(request.headers.get('authorization') || '', secret)) return reply(401);

    const raw = await request.text();
    if (raw.length > 16 * 1024) return reply(413);
    let body;
    try {
        body = JSON.parse(raw);
    } catch {
        return reply(400);
    }
    const vote = botList.parseVote(body);
    if (!vote) return reply(400);

    const { error } = await createServiceClient().from('zb_votes').insert(vote);
    if (error) {
        console.error('[vote webhook] insert failed:', error.message);
        return reply(500);
    }
    after(() => sendDirectMessage(vote.user_discord_id, botList.VOTE_THANKS).catch((e) => console.error('[vote webhook] thank-you DM failed:', e?.status || e?.message)));
    return reply(204);
}
