/**
 * Section M, operator tools (docs/ZIGBOT_FEATURE_MATRIX.md): maintenance
 * mode, emergency shutdown and a status report, for the BOT OWNER only
 * (BOT_CREATOR_ID / SERVER_OWNER_ID), with a confirmation button for the
 * high-impact actions. The /owner command is registered in home servers
 * only (src/slash.js).
 *
 *   maintenance on  -> members get no replies (slash commands answer
 *                      "under maintenance"); the owner is not affected.
 *                      Saved, so it survives a restart.
 *   shutdown        -> maintenance on + the Discord connection is closed.
 *                      The process and its health server keep running, so
 *                      the host does not restart it into a loop; restart
 *                      the service to bring ZiGBoT back.
 */
const crypto = require('node:crypto');
const { reply, makeAudit } = require('./common');

const OPS_GUILD = '00000000000000000'; // bot-wide records (no real Discord id is all zeros)
const CONFIRM_MS = 60_000;
const PREFIX = 'zbo:';

function createOps({ store, auditLog, ownerId = '', onShutdown = async () => {}, getStatus = () => ({}), now = () => Date.now(), logger = console }) {
    const audit = makeAudit({ auditLog, logger, event: 'OPS' });
    let maintenance = false;
    const pendingConfirm = new Map(); // nonce -> { action, at }
    const isOwner = (userId) => Boolean(ownerId) && String(userId) === String(ownerId);

    async function load() {
        try {
            maintenance = Boolean((await store.get(OPS_GUILD, 'ops', 'maintenance'))?.data?.on);
        } catch (error) {
            logger.error?.(`[ZiGBoT OPS] load failed: ${error?.message || error}`);
        }
        return maintenance;
    }

    async function setMaintenance(on, by) {
        maintenance = Boolean(on);
        await store.put(OPS_GUILD, 'ops', 'maintenance', { on: maintenance, by, at: now() }).catch((error) => logger.error?.(`[ZiGBoT OPS] save failed: ${error?.message || error}`));
    }

    /** For the message listener: true = say nothing to this author right now. */
    const blocksMessage = (message) => maintenance && !isOwner(message?.author?.id);

    /** For the interaction listener: true = handled here (blocked); the caller stops. */
    async function gateInteraction(interaction) {
        if (!maintenance || isOwner(interaction?.user?.id)) return false;
        if (interaction?.isRepliable?.() && !interaction.replied && !interaction.deferred) {
            await interaction.reply({ content: '🛠️ ZiGBoT is under maintenance right now. Please try again a little later.', ephemeral: true, allowedMentions: { parse: [] } }).catch(() => {});
        }
        return true;
    }

    function statusText() {
        const s = getStatus() || {};
        const yes = (v) => (v ? '✅' : '❌');
        return [
            `🩺 **ZiGBoT status**${maintenance ? ' · 🛠️ MAINTENANCE' : ''}`,
            `Discord: ${yes(s.discord?.ready)} · ${s.discord?.guilds ?? '?'} servers · ping ${s.discord?.ping ?? '?'} ms`,
            `MongoDB: ${yes(s.database?.mongo)} · Supabase config: ${yes(s.database?.supabase)}`,
            `AI providers: ${(s.ai?.providers || []).join(', ') || 'none'}`,
            `Feature scheduler: ${s.workers?.scheduler?.running ? '✅' : '❌'} · last tick ${s.workers?.scheduler?.lastTickAt ? `<t:${Math.floor(s.workers.scheduler.lastTickAt / 1000)}:R>` : 'never'} · ${s.workers?.scheduler?.failed ?? 0} failed jobs`,
            `Uptime: ${Math.round((s.uptimeSeconds || 0) / 60)} min`
        ].join('\n');
    }

    async function confirmButtons(interaction, action, question) {
        const nonce = crypto.randomUUID().slice(0, 12);
        pendingConfirm.set(nonce, { action, at: now() });
        for (const [key, value] of pendingConfirm) if (now() - value.at > CONFIRM_MS) pendingConfirm.delete(key);
        return reply(interaction, {
            content: `${question}\nConfirm within 60 seconds.`,
            components: [{ type: 1, components: [
                { type: 2, style: 4, label: 'Confirm', custom_id: `${PREFIX}${nonce}:yes` },
                { type: 2, style: 2, label: 'Cancel', custom_id: `${PREFIX}${nonce}:no` }
            ] }]
        });
    }

    async function handleSlash(interaction) {
        const sub = interaction.options.getSubcommand();
        if (!isOwner(interaction.user?.id)) {
            await audit(interaction, {}, { action: `owner_${sub}`, result: 'DENIED', details: { reason: 'not the bot owner' } });
            return reply(interaction, '❌ Only the bot owner can use this.');
        }
        if (sub === 'status') return reply(interaction, statusText());
        if (sub === 'maintenance') {
            const on = interaction.options.getString('state') === 'on';
            if (!on) {
                await setMaintenance(false, interaction.user.id);
                await audit(interaction, {}, { action: 'maintenance_off' });
                return reply(interaction, '✅ Maintenance mode is off. ZiGBoT answers everyone again.');
            }
            return confirmButtons(interaction, 'maintenance_on', '🛠️ Turn on maintenance mode? Members will get no replies until you turn it off.');
        }
        if (sub === 'shutdown') return confirmButtons(interaction, 'shutdown', '🛑 **Emergency shutdown?** ZiGBoT goes offline in every server. You will need to restart the service to bring it back.');
        return reply(interaction, '❌ Unknown option.');
    }

    async function handleComponent(interaction) {
        const [nonce, answer] = interaction.customId.slice(PREFIX.length).split(':');
        if (!isOwner(interaction.user?.id)) {
            await audit(interaction, {}, { action: 'owner_confirm', result: 'DENIED', details: { reason: 'not the bot owner' } });
            return reply(interaction, '❌ Only the bot owner can confirm this.');
        }
        const pending = pendingConfirm.get(nonce);
        pendingConfirm.delete(nonce); // one use only
        if (!pending || now() - pending.at > CONFIRM_MS) return reply(interaction, '⌛ This confirmation expired. Run the command again.');
        if (answer !== 'yes') return reply(interaction, 'Cancelled. Nothing changed.');
        await setMaintenance(true, interaction.user.id);
        if (pending.action === 'maintenance_on') {
            await audit(interaction, {}, { action: 'maintenance_on' });
            return reply(interaction, '🛠️ Maintenance mode is on. Turn it off with `/owner maintenance state:off`.');
        }
        await audit(interaction, {}, { action: 'emergency_shutdown' });
        await reply(interaction, '🛑 Shutting down the Discord connection now.').catch(() => {});
        logger.error?.('[ZiGBoT OPS] Emergency shutdown requested by the bot owner.');
        await onShutdown();
        return null;
    }

    return {
        load,
        isMaintenance: () => maintenance,
        blocksMessage,
        gateInteraction,
        statusText,
        handlesSlash: (interaction) => interaction.commandName === 'owner',
        handleSlash,
        isComponent: (interaction) => typeof interaction.customId === 'string' && interaction.customId.startsWith(PREFIX),
        handleComponent
    };
}

module.exports = { createOps, OPS_GUILD };
