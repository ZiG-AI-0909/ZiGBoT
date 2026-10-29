/**
 * Anti-Nuke alert messages. Plain Discord text (no embeds needed), always
 * under 2000 characters, with explicit mention control: only the server
 * owner (if enabled), the configured staff role, and @everyone (CRITICAL
 * only, and only if the admins turned that on) can ever be pinged.
 */
const { ANTINUKE_RULES } = require('../../dashboard/lib/shared/antinuke');

const ICON = { CRITICAL: '🚨', HIGH: '⚠️', MEDIUM: '🔎' };
const MAX = 1950;

// What containment did, worded from the verified result only.
function containmentLine(containment) {
    switch (containment?.status) {
        case 'succeeded': return `✅ Automatic containment: ${containment.summary || 'done'} (verified).`;
        case 'partial': return `⚠️ Automatic containment only partly worked: ${containment.summary || ''} Check the dashboard for what failed.`.replace(/\s+/g, ' ');
        case 'failed': return `❌ Automatic containment was attempted but FAILED: ${containment.summary || 'Discord refused the action'}. Act manually now.`;
        case 'skipped': return `⏸️ Automatic containment did not run: ${containment.summary || 'not safe or not possible here'}. Act manually.`;
        case 'not_applicable': return 'ℹ️ No automatic action applies to this kind of incident. Nothing was blocked or undone.';
        default: return 'ℹ️ Automatic containment is off for this server. Nothing was blocked or undone; follow the steps below.';
    }
}

/**
 * { content, allowedMentions } for one incident.
 * guild: { id, name, ownerId }. settings: sanitized Anti-Nuke settings.
 */
function buildAlert({ incident, guild, settings, containment = null, dashboardUrl = '', when = Date.now() }) {
    const rule = ANTINUKE_RULES[incident.rule];
    const severity = incident.severity;
    const notify = [];
    const users = [];
    const roles = [];
    let everyone = false;
    if (settings.notify_owner && guild.ownerId) {
        notify.push(`<@${guild.ownerId}>`);
        users.push(String(guild.ownerId));
    }
    if (settings.staff_role_id && severity !== 'MEDIUM') {
        notify.push(`<@&${settings.staff_role_id}>`);
        roles.push(settings.staff_role_id);
    }
    if (severity === 'CRITICAL' && settings.everyone_on_critical) {
        notify.push('@everyone');
        everyone = true;
    }

    const lines = [
        `${ICON[severity]} **ZiGBoT Anti-Nuke — ${severity} SECURITY ALERT**${incident.delivery === 'escalated' ? ' (escalated)' : ''}`,
        notify.length ? notify.join(' ') : null,
        '',
        `**Server:** ${String(guild.name || guild.id).replace(/[*_~`|>]/g, '')}`,
        `**Time:** <t:${Math.floor(when / 1000)}:F>`,
        `**Incident:** ${rule.title}`,
        incident.actorId ? `**Suspected actor:** <@${incident.actorId}> (\`${incident.actorId}\`)${incident.actorIsBot ? ' — a bot' : ''}` : '**Suspected actor:** not identified (Discord did not report one)',
        incident.botId && incident.botId !== incident.actorId ? `**Bot involved:** <@${incident.botId}> (\`${incident.botId}\`)` : null,
        incident.count ? `**Affected:** ${incident.count}${incident.targetIds?.length ? ` (IDs: ${incident.targetIds.slice(0, 8).map((id) => `\`${id}\``).join(', ')}${incident.targetIds.length > 8 ? ', …' : ''})` : ''}` : null,
        '',
        '**Why this was flagged:**',
        `• ${incident.reason}`,
        '• ZiGBoT flags patterns; a person must confirm whether this was authorised.',
        '',
        containmentLine(containment),
        '',
        '**Immediate steps:**',
        ...rule.steps.map((step, i) => `${i + 1}. ${step}`),
        '',
        `**ZiGBoT status:** monitoring active.${dashboardUrl ? ` Details and history: <${dashboardUrl}>` : ''}`
    ].filter((line) => line !== null);
    let content = lines.join('\n');
    if (content.length > MAX) content = `${content.slice(0, MAX - 1)}…`;
    return {
        content,
        // Explicit allow-list: the actor, targets and anything else stay unpinged.
        allowedMentions: { parse: everyone ? ['everyone'] : [], users, roles }
    };
}

module.exports = { buildAlert, containmentLine };
