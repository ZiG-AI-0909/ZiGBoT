/**
 * Anti-Nuke: the rules the bot (src/antinuke/) and the dashboard share, so
 * they can never disagree. CommonJS, like the rest of lib/shared.
 *
 * Free for every server. Baseline monitoring and alerts cannot be switched
 * off; only the optional automated containment can. Nothing here claims
 * prevention: Discord reports most actions after they happen, so ZiGBoT
 * detects, alerts and (only if an admin enabled it) contains.
 */
const SNOWFLAKE = /^\d{17,20}$/;

// Discord permission bits (BigInt).
const BITS = Object.freeze({
    KICK_MEMBERS: 1n << 1n,
    BAN_MEMBERS: 1n << 2n,
    ADMINISTRATOR: 1n << 3n,
    MANAGE_CHANNELS: 1n << 4n,
    MANAGE_GUILD: 1n << 5n,
    VIEW_AUDIT_LOG: 1n << 7n,
    VIEW_CHANNEL: 1n << 10n,
    SEND_MESSAGES: 1n << 11n,
    MANAGE_ROLES: 1n << 28n,
    MANAGE_WEBHOOKS: 1n << 29n
});

// Permissions that let someone damage a server. Granting one is watched.
const DANGEROUS_PERMISSIONS = Object.freeze([
    { bit: BITS.ADMINISTRATOR, name: 'Administrator' },
    { bit: BITS.MANAGE_GUILD, name: 'Manage Server' },
    { bit: BITS.MANAGE_ROLES, name: 'Manage Roles' },
    { bit: BITS.MANAGE_CHANNELS, name: 'Manage Channels' },
    { bit: BITS.MANAGE_WEBHOOKS, name: 'Manage Webhooks' },
    { bit: BITS.BAN_MEMBERS, name: 'Ban Members' },
    { bit: BITS.KICK_MEMBERS, name: 'Kick Members' }
]);

function toBits(value) {
    try {
        return BigInt(value ?? 0);
    } catch {
        return 0n;
    }
}

/** Names of the dangerous permissions in `bits` (all of them for Administrator). */
function dangerousPermissionNames(bits) {
    const value = toBits(bits);
    return DANGEROUS_PERMISSIONS.filter((p) => (value & p.bit) === p.bit).map((p) => p.name);
}

const SEVERITIES = Object.freeze(['CRITICAL', 'HIGH', 'MEDIUM']);
const SEVERITY_RANK = Object.freeze({ MEDIUM: 1, HIGH: 2, CRITICAL: 3 });
const INCIDENT_STATUSES = Object.freeze(['open', 'acknowledged', 'resolved']);

// Every rule the engine can raise: severity, a plain title, and the
// step-by-step guidance shown in the Discord alert and the dashboard.
// Steps never claim anything was blocked or restored.
const COMMON_FINAL = 'Check whether the actor\'s account or bot token may be compromised, and reset it if so.';
const RULES = Object.freeze({
    mass_delete: {
        severity: 'CRITICAL',
        title: 'Mass deletion of channels or roles',
        steps: [
            'Open Server Settings → Audit Log and confirm who deleted the channels or roles.',
            'If it was not authorised, remove that account\'s dangerous permissions (or its roles) using an owner or senior admin account.',
            'Check the remaining channels and the role order for further changes.',
            'Recreate what was deleted from your own backups or notes. Discord cannot restore deleted channels or roles, and neither can ZiGBoT.',
            COMMON_FINAL
        ]
    },
    mass_removal: {
        severity: 'CRITICAL',
        title: 'Mass bans, kicks or prune',
        steps: [
            'Open the Audit Log and confirm who removed the members.',
            'If it was not authorised, remove that account\'s Ban/Kick permissions straight away.',
            'Review Server Settings → Bans and unban members who were removed by mistake.',
            'Share a fresh invite with removed members once the server is safe.',
            COMMON_FINAL
        ]
    },
    permission_then_destroy: {
        severity: 'CRITICAL',
        title: 'Dangerous permissions followed by destructive actions',
        steps: [
            'Open the Audit Log: find the permission change and every action the same account took after it.',
            'Revert the permission change and remove the account\'s dangerous roles with an owner or senior admin account.',
            'Review recently added bots, webhooks and integrations.',
            'Recreate anything deleted from your own backups or notes.',
            COMMON_FINAL
        ]
    },
    mass_create: {
        severity: 'HIGH',
        title: 'Burst of new channels or roles',
        steps: [
            'Open the Audit Log and confirm who created them.',
            'If it was not authorised, remove that account\'s Manage Channels / Manage Roles permissions.',
            'Delete the spam channels or roles once the account is contained.',
            COMMON_FINAL
        ]
    },
    admin_grant: {
        severity: 'HIGH',
        title: 'Administrator permission granted',
        steps: [
            'Open the Audit Log: see who changed the role or member, and which role or member gained Administrator.',
            'Confirm it was part of planned maintenance.',
            'If not, revert the change with an owner or senior admin account.',
            'Review every action taken by the affected accounts after the change.'
        ]
    },
    permission_churn: {
        severity: 'HIGH',
        title: 'Repeated permission changes',
        steps: [
            'Open the Audit Log and review the role and channel permission changes by this account.',
            'If they were not authorised, revert them and remove the account\'s Manage Roles / Manage Channels permissions.',
            'Check that private channels are still private.'
        ]
    },
    bot_added_admin: {
        severity: 'HIGH',
        title: 'Bot added with Administrator',
        steps: [
            'Open the Audit Log and check who added the bot.',
            'Check the bot\'s role: does it really need Administrator? Most bots do not.',
            'If the bot was not authorised, kick it with an admin account and review recent role, channel and webhook changes.',
            'Lower its permissions to only what it needs if you keep it.'
        ]
    },
    webhook_burst: {
        severity: 'HIGH',
        title: 'Burst of webhook changes',
        steps: [
            'Open Server Settings → Integrations → Webhooks and review recently created or changed webhooks.',
            'Delete any webhook you do not recognise (this also stops its URL from posting).',
            'Check the Audit Log for who made them and remove their Manage Webhooks permission if not authorised.',
            'Review recent messages posted by webhooks for spam or scam links.'
        ]
    },
    join_burst: {
        severity: 'HIGH',
        title: 'Join burst (possible raid)',
        steps: [
            'Raise Server Settings → Safety Setup → Verification Level while you check.',
            'Review the newest members (sort by join date) for spam or look-alike accounts.',
            'Pause invites (Server Settings → Invites) if the joins keep coming.',
            'Remove raid accounts with an admin account once you are sure.'
        ]
    },
    dangerous_grant: {
        severity: 'MEDIUM',
        title: 'Dangerous permission granted',
        steps: [
            'Open the Audit Log and check which role or member gained the permission, and who granted it.',
            'Confirm it was intended; revert it if not.'
        ]
    },
    bot_added_elevated: {
        severity: 'MEDIUM',
        title: 'Bot added with powerful permissions',
        steps: [
            'Check who added the bot and whether it needs the listed permissions.',
            'Lower its role\'s permissions to only what it needs, or kick it if it was not authorised.'
        ]
    },
    mod_burst: {
        severity: 'MEDIUM',
        title: 'Burst of moderation actions',
        steps: [
            'Check the Audit Log: was this a planned clean-up?',
            'If not, talk to the moderator, and remove their Ban/Kick permissions if the account may be compromised.'
        ]
    }
});

// Thresholds: counts per actor inside the rolling window (joins: per server).
const THRESHOLD_LIMITS = Object.freeze({
    window_seconds: { min: 10, max: 600, default: 60, label: 'Detection window (seconds)' },
    mass_delete: { min: 2, max: 50, default: 4, label: 'Channel/role deletions → CRITICAL' },
    mass_removal: { min: 2, max: 100, default: 5, label: 'Bans/kicks → CRITICAL' },
    mass_create: { min: 3, max: 100, default: 8, label: 'Channel/role creations → HIGH' },
    permission_churn: { min: 3, max: 100, default: 6, label: 'Permission changes → HIGH' },
    webhook_burst: { min: 2, max: 50, default: 3, label: 'Webhook changes → HIGH' },
    mod_burst: { min: 2, max: 50, default: 3, label: 'Bans/kicks → MEDIUM' },
    join_burst: { min: 3, max: 500, default: 10, label: 'Member joins → HIGH' },
    join_window_seconds: { min: 10, max: 300, default: 30, label: 'Join window (seconds)' }
});
const CONTAINMENT_OPTIONS = Object.freeze({
    strip_dangerous_roles: {
        label: 'Remove dangerous roles from an attacker',
        help: 'On a CRITICAL incident, ZiGBoT removes the roles that give the attacker dangerous permissions. Reversible: the removed roles are listed in the incident so you can give them back. Never the server owner, never roles above ZiGBoT\'s own.',
        permission: 'Manage Roles'
    },
    remove_unauthorized_bots: {
        label: 'Kick bots added with Administrator by an untrusted account',
        help: 'Kicks (does not ban) a newly added bot that has Administrator when the person who added it is neither the owner nor a trusted admin. You can re-invite it at any time.',
        permission: 'Kick Members'
    }
});
const LIMITS = Object.freeze({ trustedUsers: 25, cooldownMin: 1, cooldownMax: 120, maintenanceMaxHours: 6, retentionDays: 90 });

function defaultThresholds() {
    return Object.fromEntries(Object.entries(THRESHOLD_LIMITS).map(([key, limit]) => [key, limit.default]));
}

/** Safe defaults: monitoring + owner alerts on, every optional action off. */
function defaultAntiNukeSettings(guildId = null) {
    return {
        guild_id: guildId ? String(guildId) : null,
        alert_channel_id: null,
        notify_owner: true,
        staff_role_id: null,
        everyone_on_critical: false,
        cooldown_minutes: 10,
        thresholds: defaultThresholds(),
        containment: { strip_dangerous_roles: false, remove_unauthorized_bots: false },
        trusted_user_ids: [],
        maintenance_until: null
    };
}

const clampInt = (value, { min, max }, fallback) => {
    const n = Number(value);
    return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
};

/** A stored row (or nothing) as complete, valid settings. Never throws. */
function sanitizeAntiNukeSettings(row, guildId = null) {
    const base = defaultAntiNukeSettings(guildId ?? row?.guild_id);
    if (!row || typeof row !== 'object') return base;
    const thresholds = { ...base.thresholds };
    for (const [key, limit] of Object.entries(THRESHOLD_LIMITS)) thresholds[key] = clampInt(row.thresholds?.[key], limit, limit.default);
    const containment = {};
    for (const key of Object.keys(CONTAINMENT_OPTIONS)) containment[key] = row.containment?.[key] === true;
    const until = Date.parse(row.maintenance_until || '');
    return {
        ...base,
        alert_channel_id: SNOWFLAKE.test(String(row.alert_channel_id || '')) ? String(row.alert_channel_id) : null,
        notify_owner: row.notify_owner !== false,
        staff_role_id: SNOWFLAKE.test(String(row.staff_role_id || '')) ? String(row.staff_role_id) : null,
        everyone_on_critical: row.everyone_on_critical === true,
        cooldown_minutes: clampInt(row.cooldown_minutes, { min: LIMITS.cooldownMin, max: LIMITS.cooldownMax }, base.cooldown_minutes),
        thresholds,
        containment,
        trusted_user_ids: (Array.isArray(row.trusted_user_ids) ? row.trusted_user_ids : []).map(String).filter((id) => SNOWFLAKE.test(id)).slice(0, LIMITS.trustedUsers),
        maintenance_until: Number.isFinite(until) ? new Date(until).toISOString() : null
    };
}

/**
 * Validate dashboard input. channelIds / roleIds: Sets of THIS server's
 * real ids (from Discord, never the browser). Returns { ok, value, errors }.
 * There is no field that turns monitoring or alerts off.
 */
function validateAntiNukeSettings(input, { channelIds = null, roleIds = null, guildId = null, now = Date.now() } = {}) {
    const errors = {};
    const src = input && typeof input === 'object' ? input : {};
    const base = defaultAntiNukeSettings(guildId);
    const id = (field, value, allowed, what) => {
        if (value === undefined || value === null || value === '') return null;
        if (!SNOWFLAKE.test(String(value)) || (allowed && !allowed.has(String(value)))) {
            errors[field] = `Pick a ${what} from this server.`;
            return null;
        }
        return String(value);
    };
    const bool = (field, value, fallback) => {
        if (value === undefined) return fallback;
        if (typeof value !== 'boolean') {
            errors[field] = 'Must be on or off.';
            return fallback;
        }
        return value;
    };
    const thresholds = {};
    for (const [key, limit] of Object.entries(THRESHOLD_LIMITS)) {
        const raw = src.thresholds?.[key];
        if (raw === undefined) {
            thresholds[key] = limit.default;
            continue;
        }
        const n = Number(raw);
        if (!Number.isInteger(n) || n < limit.min || n > limit.max) {
            errors[`thresholds.${key}`] = `${limit.label}: a whole number from ${limit.min} to ${limit.max}.`;
            thresholds[key] = limit.default;
        } else {
            thresholds[key] = n;
        }
    }
    if (thresholds.mod_burst >= thresholds.mass_removal) {
        errors['thresholds.mod_burst'] = 'The MEDIUM ban/kick count must be lower than the CRITICAL one.';
    }
    const containment = {};
    for (const key of Object.keys(CONTAINMENT_OPTIONS)) containment[key] = bool(`containment.${key}`, src.containment?.[key], false);

    const trusted = Array.isArray(src.trusted_user_ids) ? [...new Set(src.trusted_user_ids.map((v) => String(v).trim()).filter(Boolean))] : [];
    if (trusted.some((v) => !SNOWFLAKE.test(v))) errors.trusted_user_ids = 'Trusted accounts must be Discord user IDs (17-20 digits).';
    if (trusted.length > LIMITS.trustedUsers) errors.trusted_user_ids = `At most ${LIMITS.trustedUsers} trusted accounts.`;

    let maintenanceUntil = null;
    if (src.maintenance_until) {
        const at = Date.parse(src.maintenance_until);
        if (!Number.isFinite(at) || at <= now || at > now + LIMITS.maintenanceMaxHours * 3_600_000) {
            errors.maintenance_until = `Maintenance mode can last up to ${LIMITS.maintenanceMaxHours} hours from now.`;
        } else {
            maintenanceUntil = new Date(at).toISOString();
        }
    }
    const cooldown = src.cooldown_minutes === undefined ? base.cooldown_minutes : Number(src.cooldown_minutes);
    if (!Number.isInteger(cooldown) || cooldown < LIMITS.cooldownMin || cooldown > LIMITS.cooldownMax) {
        errors.cooldown_minutes = `Alert cooldown: ${LIMITS.cooldownMin} to ${LIMITS.cooldownMax} minutes.`;
    }

    const value = {
        guild_id: guildId ? String(guildId) : null,
        alert_channel_id: id('alert_channel_id', src.alert_channel_id, channelIds, 'text channel'),
        notify_owner: bool('notify_owner', src.notify_owner, true),
        staff_role_id: id('staff_role_id', src.staff_role_id, roleIds, 'role'),
        everyone_on_critical: bool('everyone_on_critical', src.everyone_on_critical, false),
        cooldown_minutes: Number.isInteger(cooldown) ? cooldown : base.cooldown_minutes,
        thresholds,
        containment,
        trusted_user_ids: trusted.filter((v) => SNOWFLAKE.test(v)).slice(0, LIMITS.trustedUsers),
        maintenance_until: maintenanceUntil
    };
    if (value.staff_role_id && guildId && value.staff_role_id === String(guildId)) errors.staff_role_id = 'Use the @everyone option for everyone, not a staff role.';
    return { ok: Object.keys(errors).length === 0, value, errors };
}

/**
 * The permissions ZiGBoT needs for these settings, and which are missing.
 * `bits`: ZiGBoT's own server-wide permissions (Administrator covers all).
 * Baseline monitoring cannot see actions without View Audit Log.
 */
function requiredPermissions(settings) {
    const s = settings || defaultAntiNukeSettings();
    const list = [
        { bit: BITS.VIEW_AUDIT_LOG, name: 'View Audit Log', why: 'to see who did what (baseline monitoring)', baseline: true },
        { bit: BITS.VIEW_CHANNEL, name: 'View Channels', why: 'to reach the alert channel', baseline: true },
        { bit: BITS.SEND_MESSAGES, name: 'Send Messages', why: 'to post security alerts', baseline: true },
        { bit: BITS.MANAGE_CHANNELS, name: 'Manage Channels', why: 'to create the private #zigbot-security alert channel (optional if you pick a channel)', baseline: false }
    ];
    if (s.containment?.strip_dangerous_roles) list.push({ bit: BITS.MANAGE_ROLES, name: 'Manage Roles', why: 'to remove an attacker\'s dangerous roles', baseline: false });
    if (s.containment?.remove_unauthorized_bots) list.push({ bit: BITS.KICK_MEMBERS, name: 'Kick Members', why: 'to kick an unauthorised bot', baseline: false });
    return list;
}

function missingPermissions(bits, settings) {
    const value = toBits(bits);
    if ((value & BITS.ADMINISTRATOR) === BITS.ADMINISTRATOR) return [];
    return requiredPermissions(settings).filter((p) => (value & p.bit) !== p.bit);
}

module.exports = {
    ANTINUKE_BITS: BITS,
    DANGEROUS_PERMISSIONS,
    dangerousPermissionNames,
    ANTINUKE_SEVERITIES: SEVERITIES,
    SEVERITY_RANK,
    INCIDENT_STATUSES,
    ANTINUKE_RULES: RULES,
    THRESHOLD_LIMITS,
    CONTAINMENT_OPTIONS,
    ANTINUKE_LIMITS: LIMITS,
    defaultAntiNukeSettings,
    sanitizeAntiNukeSettings,
    validateAntiNukeSettings,
    requiredPermissions,
    missingPermissions,
    toPermissionBits: toBits
};
