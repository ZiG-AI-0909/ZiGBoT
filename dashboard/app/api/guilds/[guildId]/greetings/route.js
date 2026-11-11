import shared from '@/lib/shared';
import { handler, json, readJson, HttpError } from '@/lib/http';
import { requireGuildAdmin } from '@/lib/auth';
import { createServiceClient } from '@/lib/supabase/server';
import { claimSlot } from '@/lib/shared/quota';
import { greetingChannels, assertCanSend, assertCanPing, pingableRoles, scheduleView, missingTableMessage, TABLE } from '@/lib/greetings';

const { validateGreeting, GREETING_LIMITS, GREETING_PLACEHOLDERS, GREETING_TYPES } = shared;

export const dynamic = 'force-dynamic';

// Scheduled greetings for THIS server. Every query is pinned to the guild id
// verified by requireGuildAdmin (live Discord check: owner, Administrator or
// Manage Server). The service role is used only after that check.

function fail(error, what) {
    const failure = new Error(`${what}: ${error.message}`);
    failure.publicMessage = missingTableMessage(error) || undefined;
    return failure;
}

// GET: this server's schedules, plus the channels ZiGBoT can post in.
export const GET = handler(async (_request, { params }) => {
    const { guildId } = await params;
    const { guild } = await requireGuildAdmin(guildId);
    const [channels, result] = await Promise.all([
        greetingChannels(guild),
        createServiceClient().from(TABLE).select('*').eq('guild_id', String(guild.id)).order('created_at', { ascending: true })
    ]);
    if (result.error) throw fail(result.error, 'Greeting read failed');
    return json({
        schedules: (result.data || []).map(scheduleView),
        channels,
        roles: pingableRoles(guild),
        meta: { limits: GREETING_LIMITS, placeholders: GREETING_PLACEHOLDERS, types: GREETING_TYPES, serverName: guild.name }
    });
});

// POST: create a schedule (validated, channel checked, next time computed here).
export const POST = handler(async (request, { params }) => {
    const { guildId } = await params;
    const { guild, discordId } = await requireGuildAdmin(guildId);
    const body = await readJson(request);
    const channels = await greetingChannels(guild);
    const result = validateGreeting(body?.schedule, { channelIds: new Set(channels.map((c) => c.id)), roleIds: new Set(pingableRoles(guild).map((r) => r.id)) });
    if (!result.ok) throw new HttpError(422, 'Some fields need fixing.', { fieldErrors: result.errors });
    assertCanPing(guild, assertCanSend(channels, result.value.channel_id), result.value.ping_target);

    const db = createServiceClient();
    const gid = String(guild.id);
    const countRows = async () => {
        const { count, error } = await db.from(TABLE).select('id', { count: 'exact', head: true }).eq('guild_id', gid);
        if (error) throw fail(error, 'Greeting count failed');
        return count;
    };
    const full = () => new HttpError(409, `A server can have up to ${GREETING_LIMITS.perGuild} scheduled greetings. Delete one first.`);
    // Quick refusal for the normal case; claimSlot below is what actually
    // holds the cap when several creates arrive at once (lib/shared/quota.js).
    if ((await countRows() || 0) >= GREETING_LIMITS.perGuild) throw full();

    const claim = await claimSlot({
        limit: GREETING_LIMITS.perGuild,
        insert: async () => {
            const { data, error } = await db.from(TABLE).insert({
                ...result.value,
                guild_id: gid,
                created_by_discord_id: discordId,
                updated_by_discord_id: discordId
            }).select('*').single();
            if (error) throw fail(error, 'Greeting save failed');
            return data;
        },
        count: countRows,
        release: async (row) => {
            const { error } = await db.from(TABLE).delete().eq('id', row.id).eq('guild_id', gid);
            if (error) console.error('[greetings] over-cap row cleanup failed:', error.message);
        }
    });
    if (!claim.ok) throw full();
    return json({ schedule: scheduleView(claim.value) }, 201);
});
