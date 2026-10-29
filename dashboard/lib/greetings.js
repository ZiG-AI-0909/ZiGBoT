import 'server-only';
import shared from './shared';
import { getChannels, getBotUser, getMember } from './discord';
import { HttpError } from './http';

const { computeChannelPermissions, describeSchedule } = shared;

// Scheduled greetings, server side. Everything here uses data fetched with
// the bot token, never anything the browser sent.

const VIEW_AND_SEND = (1n << 10n) | (1n << 11n);
const TEXT_TYPES = new Set([0, 5]); // text, announcement
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const TABLE = 'zb_greeting_schedules';

/** This server's text channels, each with whether ZiGBoT can view it and send there. */
export async function greetingChannels(guild) {
    const [channels, bot] = await Promise.all([getChannels(guild.id), getBotUser()]);
    const me = bot?.id ? await getMember(guild.id, bot.id) : null;
    return channels
        .filter((c) => TEXT_TYPES.has(c.type))
        .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
        .map((c) => ({
            id: String(c.id),
            name: c.name,
            canSend: Boolean(me) && (computeChannelPermissions(guild, me, c) & VIEW_AND_SEND) === VIEW_AND_SEND
        }));
}

/** 422 unless ZiGBoT can post in this channel right now. */
export function assertCanSend(channels, channelId) {
    const channel = channels.find((c) => c.id === String(channelId));
    if (!channel) throw new HttpError(422, 'Pick a text channel from this server.', { fieldErrors: { channel_id: 'Pick a text channel from this server.' } });
    if (!channel.canSend) {
        const message = `ZiGBoT can't post in #${channel.name}. Give ZiGBoT the View Channel and Send Messages permissions there, or pick another channel.`;
        throw new HttpError(422, message, { fieldErrors: { channel_id: message } });
    }
    return channel;
}

/** What the browser sees for one schedule. */
export function scheduleView(row) {
    return {
        id: row.id,
        channel_id: row.channel_id,
        message: row.message,
        schedule_type: row.schedule_type,
        start_local: row.start_local,
        time_zone: row.time_zone,
        weekdays: row.weekdays || [],
        interval_minutes: row.interval_minutes,
        end_date: row.end_date,
        enabled: row.enabled,
        status: row.enabled ? 'active' : 'paused',
        description: describeSchedule(row),
        next_run_at: row.next_run_at,
        last_sent_at: row.last_sent_at,
        last_attempt_at: row.last_attempt_at,
        last_status: row.last_status,
        last_error: row.last_error,
        recent_runs: row.recent_runs || [],
        last_test_at: row.last_test_at,
        updated_at: row.updated_at
    };
}

export function missingTableMessage(error) {
    return /relation|schema cache|does not exist/i.test(error?.message || '')
        ? 'The database is missing the scheduled greetings table. Run supabase/migrations/20261030000000_zigbot_scheduled_greetings.sql in the Supabase SQL Editor.'
        : null;
}
