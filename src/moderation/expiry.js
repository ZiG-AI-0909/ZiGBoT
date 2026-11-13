function createPunishmentExpiryService({
  store,
  client,
  now = () => Date.now(),
  intervalMs = 30_000,
  logger = console
} = {}) {
  if (!store?.listDueTemporaryPunishments || !store?.completeTemporaryPunishment || !client?.guilds?.cache) {
    throw new TypeError('A persistent punishment store and Discord client are required');
  }
  const completed = new Set();
  let interval = null;
  let running = false;

  async function expire(punishment) {
    const key = `${punishment.guildId}:${punishment.id}`;
    if (completed.has(key)) return;
    const guild = client.guilds.cache.get(String(punishment.guildId));
    if (!guild) {
      logger.error?.(`[ZiGBoT MODERATION] Cannot expire punishment ${key}: guild is not cached.`);
      return;
    }

    try {
      if (punishment.type === 'ban') {
        await guild.members.unban(String(punishment.userId), 'Temporary ban expired');
      } else if (punishment.type === 'timeout') {
        let member = guild.members.cache?.get?.(String(punishment.userId));
        if (!member && typeof guild.members.fetch === 'function') {
          member = await guild.members.fetch(String(punishment.userId)).catch((error) => {
            if (error?.code === 10007) return null;
            throw error;
          });
        }
        if (member) {
          if (typeof member.timeout !== 'function') throw new Error('Member timeout method is unavailable');
          await member.timeout(null, 'Temporary timeout expired');
        }
      } else {
        logger.error?.(`[ZiGBoT MODERATION] Unknown temporary punishment type: ${punishment.type}`);
        return;
      }
    } catch (error) {
      if (!(punishment.type === 'ban' && error?.code === 10026)) {
        logger.error?.(`[ZiGBoT MODERATION] Punishment ${key} expiry failed: ${error?.message || error}`);
        return;
      }
    }

    await store.completeTemporaryPunishment(punishment.guildId, punishment.id);
    completed.add(key);
  }

  async function runOnce() {
    if (running) return;
    running = true;
    try {
      const due = await store.listDueTemporaryPunishments(now());
      for (const punishment of due) await expire(punishment);
    } finally {
      running = false;
    }
  }

  function start() {
    if (interval) return stop;
    void runOnce().catch((error) => logger.error?.(`[ZiGBoT MODERATION] Expiry scan failed: ${error?.message || error}`));
    interval = setInterval(() => {
      void runOnce().catch((error) => logger.error?.(`[ZiGBoT MODERATION] Expiry scan failed: ${error?.message || error}`));
    }, intervalMs);
    interval.unref?.();
    return stop;
  }

  function stop() {
    if (interval) clearInterval(interval);
    interval = null;
  }

  return { runOnce, start, stop };
}

module.exports = { createPunishmentExpiryService };
