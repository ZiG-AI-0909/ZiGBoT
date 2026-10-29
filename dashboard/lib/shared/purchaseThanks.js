/**
 * The Discord DM ZiGBoT sends after a verified Premium purchase. CommonJS,
 * like the rest of lib/shared, so it is testable on its own.
 */
const { planLabel } = require('./feedback');

const clean = (text) => String(text || '').replace(/[*_~`|>@]/g, '').replace(/\s+/g, ' ').trim().slice(0, 100);

/**
 * Plain Discord markdown, under 2000 characters. Links are wrapped in <>
 * so Discord shows no big preview cards. contactUrl: the creator's Discord
 * profile (may be null); portfolioUrl: the creator's contact page.
 */
function buildThanksMessage({ purchase, serverName = '', contactUrl = null, portfolioUrl = null }) {
    const server = clean(serverName);
    const contact = [
        contactUrl ? `💬 Message ZiG on Discord: <${contactUrl}>` : null,
        portfolioUrl ? `🌐 Or reach him here: <${portfolioUrl}>` : null
    ].filter(Boolean);
    return [
        '💜 **Thank you for purchasing ZiGBoT Premium!**',
        '',
        `Your **${planLabel(purchase)}**${server ? ` for **${server}**` : ''} is active now. Your support keeps ZiGBoT growing for every community. 🙏`,
        '',
        'If you face any problem or have a question about Premium, contact ZiG, ZiGBoT\'s creator:',
        ...(contact.length ? contact : ['Reply in the ZiGBoT dashboard\'s Premium tab and we will help.']),
        '',
        '_You are getting this message because you bought Premium in the ZiGBoT dashboard._'
    ].join('\n');
}

module.exports = { buildThanksMessage };
