/**
 * /identity show|reset: custom bot identity from inside Discord, for server
 * admins (Manage Server; hidden from members by default and ALSO checked
 * here). Setting a name or picture happens in the dashboard (preview and
 * picture review); Discord only views and resets. Replies are private and
 * mention nobody.
 */
const { MessageFlags, PermissionFlagsBits, escapeMarkdown } = require('discord.js');
const { identityAuditReason, identityAllowedInGuild } = require('../../dashboard/lib/shared');

const NO_MENTIONS = { parse: [] };
const REVERT_REASONS = {
    premium_lapsed: 'this server’s Premium ended',
    premium_inactive: 'this server isn’t Premium right now',
    blocked: 'custom identity was turned off for this server',
    not_enabled_here: 'custom identity isn’t available in this server yet',
    feature_disabled: 'custom identity is switched off for now'
};

function createIdentityCommands({ store, getContext, enabled, guilds = [], dashboardUrl = '' }) {
    async function show(interaction) {
        const guild = interaction.guild;
        if (!identityAllowedInGuild(guild.id, guilds)) {
            const row = await store.getRow(guild.id);
            return `🪪 Custom bot identity isn’t available in this server yet, so ZiGBoT uses its default name, picture and bio here.${row ? '\nA saved identity is kept; `/identity reset confirm:True` deletes it.' : ''}`;
        }
        const [row, ctx, blocked] = await Promise.all([store.getRow(guild.id), getContext(guild), store.isGuildBlocked(guild.id)]);
        const link = dashboardUrl ? `\nChange it in the dashboard: ${dashboardUrl}/dashboard/${guild.id}` : '\nChange it in the ZiGBoT dashboard (🪪 Identity tab).';
        if (!row) return `🪪 ZiGBoT uses its default name, picture and bio in this server.${ctx?.premium ? link : '\nCustom bot identity is a Premium feature.'}`;
        const picture = row.pending_avatar_path ? 'a new one is waiting for review' : row.avatar_path ? 'custom (approved)' : 'default';
        const lines = [
            '🪪 **ZiGBoT’s identity in this server**',
            `Name: ${row.nick ? escapeMarkdown(row.nick) : 'ZiGBoT (default)'}`,
            `Bio: ${row.bio ? escapeMarkdown(row.bio.replace(/\n/g, ' ')) : 'none'}`,
            `Picture: ${picture}`
        ];
        if (blocked) lines.push('⛔ Custom identity has been turned off for this server, so the default profile is used.');
        else if (!ctx?.premium) lines.push('💎 This server isn’t Premium right now, so the default profile is used.');
        if (row.reverted_at && REVERT_REASONS[row.revert_reason]) lines.push(`Reverted to default on ${new Date(row.reverted_at).toDateString()} because ${REVERT_REASONS[row.revert_reason]}.`);
        return lines.join('\n') + link;
    }

    async function reset(interaction) {
        if (!interaction.options.getBoolean('confirm')) return 'Nothing changed. Run `/identity reset confirm:True` to put back the default ZiGBoT profile and delete the saved identity.';
        const guild = interaction.guild;
        let discordFailed = false;
        try {
            await guild.members.editMe({ nick: null, bio: null, avatar: null, reason: identityAuditReason('reset to default', `by ${interaction.user.id}`) });
        } catch (error) {
            discordFailed = true;
            console.error(`[ZiGBoT IDENTITY] /identity reset: Discord update failed: ${error?.code || error?.status || 'Error'}`);
        }
        const row = await store.getRow(guild.id);
        if (row) {
            await store.removeAvatars([row.avatar_path, row.pending_avatar_path]);
            await store.deleteRow(guild.id);
            await store.audit({ guildId: guild.id, action: 'RESET', actorRole: 'discord_admin', before: { nick: row.nick, bio: row.bio, avatar_sha256: row.avatar_sha256 }, after: { by_discord_id: interaction.user.id } });
        }
        if (discordFailed) return `⚠️ ${row ? 'The saved identity was deleted, but ' : ''}Discord didn’t accept the profile reset. Check that I still have the Change Nickname permission and try again.`;
        return `✅ ZiGBoT is back to its default name, picture and bio here.${row ? ' The saved identity and pictures were deleted.' : ''}`;
    }

    async function handleSlash(interaction) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const send = (content) => interaction.editReply({ content, allowedMentions: NO_MENTIONS });
        if (!interaction.guild) return send('Use this command inside a server.');
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return send('❌ Only server admins (Manage Server) can use this.');
        if (!enabled || !store.enabled) return send('Custom bot identity isn’t available yet.');
        const subcommand = interaction.options.getSubcommand();
        try {
            if (subcommand === 'show') return send(await show(interaction));
            if (subcommand === 'reset') return send(await reset(interaction));
            return send('❌ Unknown subcommand.');
        } catch (error) {
            console.error(`[ZiGBoT IDENTITY] /identity ${subcommand} failed: ${error?.code || error?.name || 'Error'}`);
            return send('⚠️ That didn’t work right now. Please try again in a moment.');
        }
    }

    return { handleSlash };
}

module.exports = { createIdentityCommands };
