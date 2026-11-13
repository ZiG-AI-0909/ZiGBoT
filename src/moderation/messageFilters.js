const { auditLog: writeAuditLog } = require('../logging/auditLog');
const { canQuarantineMessage } = require('../security/response/responseEngine');

const SPAM_WINDOW_MS = 5_000;
const SPAM_MESSAGE_LIMIT = 5;
const MODERATOR_ALERT_COOLDOWN_MS = 60_000;
const MAX_TRACKED_MEMBERS = 5_000;

function messageRule(message, config, recentMessages, timestamp) {
  const content = typeof message.content === 'string' ? message.content : '';
  const key = `${message.guild.id}:${message.author.id}`;
  if (config.moderation_spam_filter_enabled && content.trim()) {
    const recent = (recentMessages.get(key) || []).filter((seenAt) => timestamp - seenAt < SPAM_WINDOW_MS);
    recent.push(timestamp);
    recentMessages.set(key, recent);
    while (recentMessages.size > MAX_TRACKED_MEMBERS) {
      recentMessages.delete(recentMessages.keys().next().value);
    }
    if (recent.length >= SPAM_MESSAGE_LIMIT) return 'spam';
  }

  if (config.moderation_caps_filter_enabled) {
    const letters = [...content].filter((character) => /\p{L}/u.test(character));
    const uppercase = letters.filter((character) => character === character.toUpperCase() && character !== character.toLowerCase()).length;
    if (letters.length >= 15 && uppercase / letters.length >= 0.8) return 'caps';
  }

  if (config.moderation_mentions_filter_enabled) {
    const mentions = (Number(message.mentions?.users?.size) || 0) + (Number(message.mentions?.roles?.size) || 0);
    if (mentions >= 5) return 'mentions';
  }

  if (config.moderation_invites_filter_enabled && /(?:discord\.gg\/|discord(?:app)?\.com\/invite\/)[\w-]+/i.test(content)) {
    return 'invite';
  }

  if (config.moderation_word_filter_enabled) {
    const words = String(config.moderation_filtered_words || '')
      .split(/[\n,]/)
      .map((word) => word.trim().toLocaleLowerCase())
      .filter(Boolean);
    const normalized = content.toLocaleLowerCase();
    if (words.some((word) => normalized.includes(word))) return 'word';
  }

  return null;
}

function createModerationFilterEngine({
  getGuildConfig,
  auditLog = writeAuditLog,
  logger = console,
  now = () => Date.now()
} = {}) {
  if (typeof getGuildConfig !== 'function') throw new TypeError('getGuildConfig must be a function');
  const recentMessages = new Map();
  const alertCooldowns = new Map();

  async function processMessage(message, resolvedConfig = null) {
    if (!message?.guild?.id || !message?.author?.id || message.author.bot) return { matched: false, deleted: false };
    const config = resolvedConfig || await getGuildConfig(message.guild);
    if (!config || typeof config !== 'object') return { matched: false, deleted: false };

    const rule = messageRule(message, config, recentMessages, now());
    if (!rule) return { matched: false, deleted: false };

    let deleted = false;
    if (canQuarantineMessage(message)) {
      try {
        await message.delete();
        deleted = true;
      } catch (error) {
        logger.error?.(`[ZiGBoT MODERATION] ${rule} quarantine failed: ${error?.message || error}`);
      }
    } else {
      logger.error?.(`[ZiGBoT MODERATION] ${rule} quarantine unavailable: missing ManageMessages, role hierarchy, or deletable message.`);
    }

    const details = { rule, quarantine: deleted };
    await auditLog({
      message,
      settings: { logChannelId: config.log_channel_id || '' },
      event: 'MODERATION FILTER',
      action: rule,
      target: message.author.id,
      result: deleted ? 'DELETED' : 'DELETE_FAILED',
      details
    });

    const alertKey = `${message.guild.id}:${message.author.id}:${rule}`;
    const lastAlert = alertCooldowns.get(alertKey);
    if (lastAlert === undefined || now() - lastAlert >= MODERATOR_ALERT_COOLDOWN_MS) {
      alertCooldowns.set(alertKey, now());
      while (alertCooldowns.size > MAX_TRACKED_MEMBERS) {
        alertCooldowns.delete(alertCooldowns.keys().next().value);
      }
    } else {
      return { matched: true, rule, deleted };
    }

    try {
      if (message.guild.owner?.send) {
        await message.guild.owner.send({
          content: `[ZiGBoT MODERATION] ${rule} filter ${deleted ? 'deleted' : 'could not delete'} a message in #${message.channel?.name || 'unknown'} from <@${message.author.id}>.`,
          allowedMentions: { parse: [] }
        });
      }
    } catch (error) {
      logger.error?.(`[ZiGBoT MODERATION] moderator alert failed: ${error?.message || error}`);
    }

    return { matched: true, rule, deleted };
  }

  return { processMessage };
}

module.exports = { createModerationFilterEngine, messageRule };
