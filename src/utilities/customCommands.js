const COMMAND_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;

function createCustomUtilityCommandHandler({ logger = console } = {}) {
    async function handle(message, configuredCommands = []) {
        if (!message?.guild || !message?.author || message.author.bot || message.webhookId || message.system) return false;
        if (typeof message.content !== 'string' || !Array.isArray(configuredCommands)) return false;
        const match = /^!([a-z0-9][a-z0-9_-]{0,31})$/i.exec(message.content.trim());
        if (!match) return false;
        const name = match[1].toLowerCase();
        const command = configuredCommands.find((item) =>
            item && typeof item.name === 'string' && item.name.toLowerCase() === name &&
            COMMAND_NAME.test(item.name) && typeof item.response === 'string' && item.response.length > 0
        );
        if (!command) return false;
        try {
            await message.reply({
                content: command.response,
                allowedMentions: { parse: [], repliedUser: false }
            });
        } catch (error) {
            logger.error?.(`[ZiGBoT UTILITIES] Custom command "${name}" failed: ${error?.message || error}`);
        }
        return true;
    }

    return { handle };
}

module.exports = { createCustomUtilityCommandHandler };
