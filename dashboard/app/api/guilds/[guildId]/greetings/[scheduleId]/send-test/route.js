import shared from '@/lib/shared';
import { handler, json, HttpError } from '@/lib/http';
import { requireGuildAdmin } from '@/lib/auth';
import { sendChannelMessage } from '@/lib/discord';
import { createServiceClient } from '@/lib/supabase/server';
import { greetingChannels, assertCanSend, UUID, TABLE } from '@/lib/greetings';

const { renderGreeting, GREETING_LIMITS } = shared;

export const dynamic = 'force-dynamic';

// POST: send the SAVED greeting once to its channel now, marked as a test.
// Only after an explicit click; at most once a minute per schedule.
export const POST = handler(async (_request, { params }) => {
    const { guildId, scheduleId } = await params;
    const { guild } = await requireGuildAdmin(guildId);
    if (!UUID.test(String(scheduleId || ''))) throw new HttpError(400, 'Invalid schedule.');
    const db = createServiceClient();
    const { data: row, error } = await db.from(TABLE).select('*').eq('id', scheduleId).eq('guild_id', String(guild.id)).maybeSingle();
    if (error) throw new Error(`Greeting read failed: ${error.message}`);
    if (!row) throw new HttpError(404, 'That scheduled greeting does not exist in this server.');

    const now = Date.now();
    const last = Date.parse(row.last_test_at || '');
    const wait = Number.isFinite(last) ? Math.ceil((GREETING_LIMITS.testCooldownSeconds * 1000 - (now - last)) / 1000) : 0;
    if (wait > 0) throw new HttpError(429, `You can send a test again in ${wait} seconds.`);

    assertCanSend(await greetingChannels(guild), row.channel_id);
    // Claim the cooldown first, so double clicks cannot send twice.
    let claim = db.from(TABLE).update({ last_test_at: new Date(now).toISOString() }).eq('id', row.id).eq('guild_id', String(guild.id));
    claim = row.last_test_at ? claim.eq('last_test_at', row.last_test_at) : claim.is('last_test_at', null);
    const { data: claimed } = await claim.select('id');
    if (!claimed || claimed.length === 0) throw new HttpError(429, 'A test was just sent. Try again in a minute.');

    const content = `${renderGreeting(row.message, { serverName: guild.name, timeZone: row.time_zone, now })}\n-# 🧪 Test greeting sent from the ZiGBoT dashboard`;
    try {
        await sendChannelMessage(row.channel_id, content);
    } catch (sendError) {
        const reason = sendError?.code === 10003 ? 'That channel no longer exists.'
            : sendError?.code === 50001 || sendError?.code === 50013 ? 'ZiGBoT is not allowed to post in that channel.'
                : 'Discord did not accept the message. Try again in a moment.';
        throw new HttpError(502, reason);
    }
    return json({ sent: true });
});
