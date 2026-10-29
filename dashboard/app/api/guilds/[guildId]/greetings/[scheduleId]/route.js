import shared from '@/lib/shared';
import { handler, json, readJson, HttpError } from '@/lib/http';
import { requireGuildAdmin } from '@/lib/auth';
import { createServiceClient } from '@/lib/supabase/server';
import { greetingChannels, assertCanSend, scheduleView, missingTableMessage, UUID, TABLE } from '@/lib/greetings';

const { validateGreeting } = shared;

export const dynamic = 'force-dynamic';

// One schedule of THIS server. Reads and writes are pinned to both the
// schedule id and the verified guild id, so an admin of one server can never
// touch another server's schedule.

async function load(db, guildId, scheduleId) {
    if (!UUID.test(String(scheduleId || ''))) throw new HttpError(400, 'Invalid schedule.');
    const { data, error } = await db.from(TABLE).select('*').eq('id', scheduleId).eq('guild_id', guildId).maybeSingle();
    if (error) {
        const failure = new Error(`Greeting read failed: ${error.message}`);
        failure.publicMessage = missingTableMessage(error) || undefined;
        throw failure;
    }
    if (!data) throw new HttpError(404, 'That scheduled greeting does not exist in this server.');
    return data;
}

// PATCH { schedule } edits everything; { enabled: true|false } resumes or pauses.
// The next send time is always recomputed here, from now (no backlog on resume).
export const PATCH = handler(async (request, { params }) => {
    const { guildId, scheduleId } = await params;
    const { guild, discordId } = await requireGuildAdmin(guildId);
    const body = await readJson(request);
    const db = createServiceClient();

    // Two tries: the bot's send claim also bumps version, so a save that races
    // a send re-reads and applies on top of it instead of failing.
    for (let attempt = 0; attempt < 2; attempt += 1) {
        const row = await load(db, String(guild.id), scheduleId);
        let input;
        if (body && typeof body.enabled === 'boolean' && !body.schedule) input = { ...row, enabled: body.enabled };
        else if (body?.schedule && typeof body.schedule === 'object') input = body.schedule;
        else throw new HttpError(400, 'Send the schedule, or enabled: true/false.');

        let next;
        if (input.enabled === false && !body.schedule) {
            // Pausing never needs the channel to be valid.
            next = { enabled: false, next_run_at: null };
        } else {
            const channels = await greetingChannels(guild);
            const result = validateGreeting(input, { channelIds: new Set(channels.map((c) => c.id)) });
            if (!result.ok) throw new HttpError(422, 'Some fields need fixing.', { fieldErrors: result.errors });
            if (result.value.enabled) assertCanSend(channels, result.value.channel_id);
            next = result.value;
        }
        const { data, error } = await db.from(TABLE)
            .update({ ...next, updated_by_discord_id: discordId, version: Number(row.version) + 1, updated_at: new Date().toISOString() })
            .eq('id', row.id)
            .eq('guild_id', String(guild.id))
            .eq('version', Number(row.version))
            .select('*');
        if (error) throw new Error(`Greeting update failed: ${error.message}`);
        if (data && data.length > 0) return json({ schedule: scheduleView(data[0]) });
    }
    throw new HttpError(409, 'This greeting changed while you were saving (it may have just been sent). Reload and try again.');
});

// DELETE: the schedule is removed; no greeting is sent for it again.
export const DELETE = handler(async (_request, { params }) => {
    const { guildId, scheduleId } = await params;
    const { guild } = await requireGuildAdmin(guildId);
    if (!UUID.test(String(scheduleId || ''))) throw new HttpError(400, 'Invalid schedule.');
    const { data, error } = await createServiceClient().from(TABLE).delete().eq('id', scheduleId).eq('guild_id', String(guild.id)).select('id');
    if (error) throw new Error(`Greeting delete failed: ${error.message}`);
    if (!data || data.length === 0) throw new HttpError(404, 'That scheduled greeting does not exist in this server.');
    return json({ deleted: true });
});
