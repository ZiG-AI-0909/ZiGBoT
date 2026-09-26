function formatDetails(details = {}) {
    return Object.entries(details)
        .map(([key, value]) => `${key}: ${value ?? 'none'}`)
        .join(' | ');
}

async function auditLog({ message, settings, event, action, target, result, details }) {
    const entry = `[ZiGBoT ${event}] user=${message.author.id} action=${action} target=${target || 'none'} result=${result}${details ? ` ${formatDetails(details)}` : ''}`;
    console.log(entry);

    if (!settings.logChannelId) return;
    // message.client is absent on some non-Discord message shapes (slash
    // fakeMessage, voice route contexts). A missing client must not crash the
    // action that is being audited — just skip the channel mirror.
    if (!message.client?.channels) return;
    const channel = await message.client.channels.fetch(settings.logChannelId).catch(() => null);
    if (channel?.isTextBased()) {
        await channel.send(`\`${entry.slice(0, 1900)}\``).catch(() => {});
    }
}

module.exports = { auditLog };
