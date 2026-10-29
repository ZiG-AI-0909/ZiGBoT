/**
 * Scheduled greetings: the rules the bot (src/greetings/scheduler.js) and the
 * dashboard share, so a schedule means exactly the same thing in both.
 * CommonJS, like the rest of lib/shared. No date library: time zones and
 * daylight-saving changes go through the built-in Intl API.
 *
 * A schedule's start is a LOCAL date and time ("2026-11-01T09:00") in its
 * own time zone; daily and weekly greetings repeat at that local time, so
 * they stay at 09:00 across daylight-saving changes. A local time that does
 * not exist on a given day (the hour skipped when clocks go forward) moves
 * to the next valid time.
 */
const SNOWFLAKE = /^\d{17,20}$/;
const LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

const GREETING_TYPES = Object.freeze(['once', 'daily', 'weekly', 'interval']);
const GREETING_LIMITS = Object.freeze({
    messageMax: 1500,
    perGuild: 5,
    intervalMinMinutes: 60, // never more than once an hour: no spam
    intervalMaxMinutes: 7 * 24 * 60,
    missedGraceMinutes: 15,
    testCooldownSeconds: 60,
    recentRuns: 5
});
const GREETING_PLACEHOLDERS = Object.freeze([
    { token: '{server}', description: 'Server name' },
    { token: '{time}', description: 'Current time in the schedule\'s time zone' },
    { token: '{date}', description: 'Current date in the schedule\'s time zone' }
]);
const WEEKDAYS = Object.freeze(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);

const formatters = new Map();
function partsFormatter(timeZone) {
    let formatter = formatters.get(timeZone);
    if (!formatter) {
        formatter = new Intl.DateTimeFormat('en-US', {
            timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
        });
        formatters.set(timeZone, formatter);
    }
    return formatter;
}

function isValidTimeZone(timeZone) {
    if (typeof timeZone !== 'string' || !timeZone || timeZone.length > 64) return false;
    try {
        partsFormatter(timeZone);
        return true;
    } catch {
        return false;
    }
}

/** Every time zone this runtime knows (UTC first). */
function timeZones() {
    const list = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
    return ['UTC', ...list.filter((tz) => tz !== 'UTC')];
}

/** The wall-clock fields of an instant in a time zone. */
function localParts(ms, timeZone) {
    const out = {};
    for (const part of partsFormatter(timeZone).formatToParts(new Date(ms))) {
        if (part.type !== 'literal') out[part.type] = Number(part.value);
    }
    return { year: out.year, month: out.month, day: out.day, hour: out.hour === 24 ? 0 : out.hour, minute: out.minute, second: out.second };
}

/** Time zone offset (ms, local minus UTC) at an instant. */
function offsetAt(ms, timeZone) {
    const p = localParts(ms, timeZone);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

/** A local wall-clock time in a time zone, as a UTC instant (ms). */
function zonedToUtc({ year, month, day, hour, minute }, timeZone) {
    const guess = Date.UTC(year, month - 1, day, hour, minute);
    const first = guess - offsetAt(guess, timeZone);
    const second = guess - offsetAt(first, timeZone);
    // Around a daylight-saving change the two can differ: prefer the one that
    // maps back to the requested wall time; otherwise (a skipped hour) the
    // later instant, which is the next valid local time.
    const back = localParts(second, timeZone);
    if (back.hour === hour && back.minute === minute) return second;
    return Math.max(first, second);
}

function parseLocal(value) {
    const m = LOCAL.exec(String(value || ''));
    if (!m) return null;
    const [year, month, day, hour, minute] = m.slice(1).map(Number);
    const check = new Date(Date.UTC(year, month - 1, day, hour, minute));
    if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day || hour > 23 || minute > 59) return null;
    return { year, month, day, hour, minute };
}

function parseDate(value) {
    const m = DATE.exec(String(value || ''));
    if (!m) return null;
    const parsed = parseLocal(`${value}T00:00`);
    return parsed ? { year: parsed.year, month: parsed.month, day: parsed.day } : null;
}

function addDays({ year, month, day }, days) {
    const d = new Date(Date.UTC(year, month - 1, day + days));
    return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

const weekdayOf = ({ year, month, day }) => new Date(Date.UTC(year, month - 1, day)).getUTCDay();

/**
 * The first send time strictly after `afterMs` (UTC ms), or null when the
 * schedule has none left (a one-time greeting already passed, or past the
 * end date). Missed times are never returned: only the next future one.
 */
function nextOccurrence(schedule, afterMs) {
    const start = parseLocal(schedule?.start_local);
    const tz = schedule?.time_zone;
    if (!start || !isValidTimeZone(tz)) return null;
    const startMs = zonedToUtc(start, tz);
    const end = schedule.end_date ? parseDate(schedule.end_date) : null;
    // The end date includes its whole day, in the schedule's time zone.
    const endMs = end ? zonedToUtc({ ...addDays(end, 1), hour: 0, minute: 0 }, tz) - 1 : Infinity;
    let candidate = null;
    switch (schedule.schedule_type) {
        case 'once':
            candidate = startMs > afterMs ? startMs : null;
            break;
        case 'interval': {
            const step = Number(schedule.interval_minutes) * 60_000;
            if (!Number.isInteger(Number(schedule.interval_minutes)) || step <= 0) return null;
            candidate = afterMs < startMs ? startMs : startMs + (Math.floor((afterMs - startMs) / step) + 1) * step;
            break;
        }
        case 'daily':
        case 'weekly': {
            const days = schedule.schedule_type === 'weekly' ? new Set((schedule.weekdays || []).map(Number)) : null;
            if (days && days.size === 0) return null;
            const from = localParts(Math.max(afterMs, startMs), tz);
            const base = { year: from.year, month: from.month, day: from.day };
            for (let i = 0; i <= 8 && candidate === null; i += 1) {
                const date = addDays(base, i);
                if (days && !days.has(weekdayOf(date))) continue;
                const at = zonedToUtc({ ...date, hour: start.hour, minute: start.minute }, tz);
                if (at > afterMs && at >= startMs) candidate = at;
            }
            break;
        }
        default:
            return null;
    }
    return candidate !== null && candidate <= endMs ? candidate : null;
}

/** The message with {server}, {time} and {date} filled in for `now`. */
function renderGreeting(message, { serverName = '', timeZone = 'UTC', now = Date.now() } = {}) {
    const tz = isValidTimeZone(timeZone) ? timeZone : 'UTC';
    const time = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit' }).format(new Date(now));
    const date = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(now));
    return String(message || '')
        .replace(/\{server\}/gi, String(serverName || 'this server').slice(0, 100))
        .replace(/\{time\}/gi, time)
        .replace(/\{date\}/gi, date);
}

const PING_SPECIAL = Object.freeze(['everyone', 'here']);

/**
 * The exact Discord message for a greeting: the mention (if any) in front,
 * and allowedMentions that permit ONLY that target. Anything typed in the
 * message itself (@everyone, other roles, users) never pings.
 * ping: false = show the mention but ping nobody (test sends).
 */
function buildGreetingMessage(schedule, { serverName = '', now = Date.now(), ping = true } = {}) {
    const text = renderGreeting(schedule.message, { serverName, timeZone: schedule.time_zone, now });
    const target = schedule.ping_target || null;
    if (!target) return { content: text, allowedMentions: { parse: [] } };
    const mention = PING_SPECIAL.includes(target) ? `@${target}` : `<@&${target}>`;
    const allowedMentions = !ping ? { parse: [] }
        : PING_SPECIAL.includes(target) ? { parse: ['everyone'] } // Discord's flag covers @everyone and @here
            : { parse: [], roles: [target] };
    return { content: `${mention} ${text}`.slice(0, 2000), allowedMentions };
}

const cleanMessage = (value) => String(value ?? '').replace(/\r\n/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim();

/**
 * Validate a schedule from the dashboard. channelIds: Set of THIS server's
 * channels ZiGBoT can post in (from Discord, never the browser).
 * Returns { ok, value, errors }; value.next_run_at is computed here (null
 * while paused), never taken from the browser.
 */
function validateGreeting(input, { channelIds = null, roleIds = null, now = Date.now() } = {}) {
    const src = input && typeof input === 'object' ? input : {};
    const errors = {};
    // Who the greeting pings: nobody (default), @everyone, @here, or one role of THIS server.
    let pingTarget = null;
    if (src.ping_target !== undefined && src.ping_target !== null && src.ping_target !== '') {
        const target = String(src.ping_target);
        if (PING_SPECIAL.includes(target) || (SNOWFLAKE.test(target) && (!roleIds || roleIds.has(target)))) pingTarget = target;
        else errors.ping_target = 'Pick a role from this server, @everyone, @here, or no ping.';
    }
    const channelId = String(src.channel_id || '');
    if (!SNOWFLAKE.test(channelId) || (channelIds && !channelIds.has(channelId))) errors.channel_id = 'Pick a text channel from this server.';
    const message = cleanMessage(src.message);
    if (!message) errors.message = 'Write a greeting.';
    else if (message.length > GREETING_LIMITS.messageMax) errors.message = `Greetings can be at most ${GREETING_LIMITS.messageMax} characters.`;
    const type = GREETING_TYPES.includes(src.schedule_type) ? src.schedule_type : null;
    if (!type) errors.schedule_type = 'Pick Once, Daily, Weekly or Custom interval.';
    const start = parseLocal(src.start_local);
    if (!start) errors.start_local = 'Pick a start date and time.';
    const timeZone = String(src.time_zone || '');
    if (!isValidTimeZone(timeZone)) errors.time_zone = 'Pick a time zone.';
    let weekdays = [];
    if (type === 'weekly') {
        weekdays = [...new Set((Array.isArray(src.weekdays) ? src.weekdays : []).map(Number))].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6).sort();
        if (weekdays.length === 0) errors.weekdays = 'Pick at least one weekday.';
    }
    let intervalMinutes = null;
    if (type === 'interval') {
        intervalMinutes = Number(src.interval_minutes);
        if (!Number.isInteger(intervalMinutes) || intervalMinutes < GREETING_LIMITS.intervalMinMinutes || intervalMinutes > GREETING_LIMITS.intervalMaxMinutes) {
            errors.interval_minutes = `Repeat every 1 to ${GREETING_LIMITS.intervalMaxMinutes / 60} hours.`;
        }
    }
    let endDate = null;
    if (src.end_date) {
        const end = parseDate(src.end_date);
        if (!end) errors.end_date = 'Pick a valid end date.';
        else if (start && Date.UTC(end.year, end.month - 1, end.day) < Date.UTC(start.year, start.month - 1, start.day)) errors.end_date = 'The end date must be on or after the start date.';
        else endDate = String(src.end_date);
    }
    if (type === 'once') endDate = null;
    const enabled = src.enabled === true;
    const value = {
        channel_id: channelId,
        message,
        schedule_type: type,
        start_local: start ? String(src.start_local) : null,
        time_zone: timeZone,
        weekdays,
        interval_minutes: type === 'interval' ? intervalMinutes : null,
        end_date: endDate,
        ping_target: pingTarget,
        enabled,
        next_run_at: null
    };
    if (Object.keys(errors).length === 0 && enabled) {
        const next = nextOccurrence(value, now);
        if (next === null) errors.start_local = type === 'once' ? 'That time has already passed. Pick a time in the future.' : 'This schedule has no send times left before its end date.';
        else value.next_run_at = new Date(next).toISOString();
    }
    return { ok: Object.keys(errors).length === 0, value, errors };
}

/** Plain description, e.g. "Every Mon, Wed at 09:00 (Asia/Kolkata)". */
function describeSchedule(schedule) {
    const time = String(schedule?.start_local || '').slice(11, 16);
    const tz = schedule?.time_zone || 'UTC';
    switch (schedule?.schedule_type) {
        case 'once': return `Once on ${String(schedule.start_local).slice(0, 10)} at ${time} (${tz})`;
        case 'daily': return `Every day at ${time} (${tz})`;
        case 'weekly': return `Every ${(schedule.weekdays || []).map((d) => WEEKDAYS[d]).join(', ')} at ${time} (${tz})`;
        case 'interval': {
            const h = Number(schedule.interval_minutes) / 60;
            return `Every ${h} hour${h === 1 ? '' : 's'} from ${String(schedule.start_local).replace('T', ' ')} (${tz})`;
        }
        default: return 'Unknown schedule';
    }
}

module.exports = {
    GREETING_TYPES,
    GREETING_LIMITS,
    GREETING_PLACEHOLDERS,
    GREETING_WEEKDAYS: WEEKDAYS,
    isValidTimeZone,
    timeZones,
    localParts,
    zonedToUtc,
    nextOccurrence,
    renderGreeting,
    buildGreetingMessage,
    GREETING_PING_SPECIAL: PING_SPECIAL,
    validateGreeting,
    describeSchedule
};
