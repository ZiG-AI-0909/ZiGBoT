const test = require('node:test');
const assert = require('node:assert/strict');

// Reaction GIFs: per-persona rules (dashboard/lib/shared/gifs.js), the
// decision and sending (src/gifs/reactions.js), GIPHY (src/gifs/giphy.js),
// bullying of another member (src/gifs/bully.js) and the AI's GIF tag.
const shared = require('../dashboard/lib/shared');
const {
    GIF_MODE_STYLES, GIF_STYLES, defaultGifSettings, validateGifSettings, sanitizeGifSettings, validateGifStyle,
    resolveGifRules, buildGifQuery, applyPlanToConfig, configPremiumErrors, validateGuildConfig, sanitizeStoredConfig
} = shared;
const { decideGif, createReactionGifs } = require('../src/gifs/reactions');
const { createGiphyClient } = require('../src/gifs/giphy');
const { detectBullying, createBullyTracker, buildBullyInstruction, modSuggestion, severeReplyText } = require('../src/gifs/bully');
const { parseGifTag, gifPromptBlock } = require('../src/ai/client');

const ROAST = Object.keys(GIF_STYLES).filter((s) => GIF_STYLES[s].roast);
const G = '123456789012345678';
const CH = '223456789012345678';
const AUTHOR = '323456789012345678';
const TARGET = '423456789012345678';
const BOT = '523456789012345678';
const rules = (over = {}) => resolveGifRules({ settings: defaultGifSettings(), tone: 'savage', ...over });
const decide = (over = {}) => decideGif({
    providerEnabled: true, gifSettings: defaultGifSettings(), rules: rules(), channelId: CH, inChatChannel: true,
    moment: 'chat', aiStyle: 'mic_drop', repliesSinceGif: 100, lastGifForUserAt: 0, now: 10 ** 12, rng: () => 0, ...over
});

test('each mode allows exactly its styles; Gentle and Neutral have no roast styles', () => {
    assert.deepEqual(GIF_MODE_STYLES.gentle, ['hug', 'cheer', 'clap', 'thumbs_up', 'laugh']);
    assert.deepEqual(GIF_MODE_STYLES.neutral, [...GIF_MODE_STYLES.gentle, 'facepalm', 'mind_blown']);
    assert.deepEqual(GIF_MODE_STYLES.savage, [...GIF_MODE_STYLES.neutral, 'mic_drop', 'side_eye', 'you_tried', 'roast']);
    for (const mode of ['gentle', 'neutral']) assert.ok(!GIF_MODE_STYLES[mode].some((s) => ROAST.includes(s)), `${mode} has no roast styles`);
    assert.deepEqual(rules({ tone: 'gentle' }).styles, GIF_MODE_STYLES.gentle);
    assert.deepEqual(rules({ tone: 'neutral' }).styles, GIF_MODE_STYLES.neutral);
    assert.deepEqual(rules({ tone: 'savage' }).styles, GIF_MODE_STYLES.savage);
});

test('saving: styles outside a mode, or roast in Gentle/Neutral, are refused; stored tampering is dropped', () => {
    const bad = validateGifSettings({ modes: { gentle: { styles: ['hug', 'mic_drop'], roast: true }, neutral: { styles: ['roast'] } } });
    assert.match(bad.error, /gentle: mic_drop is not allowed/);
    assert.match(bad.error, /gentle: roast GIFs are only available in Savage mode/);
    assert.match(bad.error, /neutral: roast is not allowed/);
    const stored = sanitizeGifSettings({ modes: { gentle: { styles: ['roast', 'mic_drop', 'hug'], roast: true, frequency: 'often' } } });
    assert.deepEqual(stored.modes.gentle, { enabled: true, frequency: 'often', styles: ['hug'] });
    assert.deepEqual(validateGifSettings({ modes: { savage: { frequency: 'constantly' } } }).error, 'savage: frequency must be rare, normal or often.');
    assert.equal(validateGifSettings(defaultGifSettings()).error, null);
});

test('Gentle can never roast — even with a tampered config or at a roast moment', () => {
    const tampered = sanitizeGifSettings({ modes: { gentle: { styles: [...ROAST, 'hug'], roast: true } } });
    const gentle = resolveGifRules({ settings: tampered, tone: 'gentle' });
    assert.equal(gentle.roastAllowed, false);
    assert.ok(!gentle.styles.some((s) => ROAST.includes(s)));
    assert.deepEqual(decide({ rules: gentle, moment: 'roast' }), { send: false, reason: 'no_style' });
    assert.equal(decide({ rules: gentle, moment: 'defend' }).style, 'hug', 'defending in Gentle mode: a hug, not a roast');
    assert.deepEqual(decide({ rules: gentle, aiStyle: 'mic_drop' }), { send: false, reason: 'no_style' }, 'an AI roast pick is ignored');
    const savageOff = resolveGifRules({ settings: validateGifSettings({ modes: { savage: { roast: false } } }).value, tone: 'savage' });
    assert.ok(!savageOff.styles.some((s) => ROAST.includes(s)), 'Savage with roast GIFs off has no roast styles either');
});

test('under-18 members always get Gentle rules, whatever the tone or persona', () => {
    const settings = validateGifSettings({ custom_style: 'pirate', modes: { gentle: { frequency: 'rare' }, savage: { frequency: 'often' } } }).value;
    for (const tone of ['savage', 'neutral', 'gentle']) {
        const minor = resolveGifRules({ settings, tone, isMinor: true, customPersona: true });
        assert.equal(minor.mode, 'gentle');
        assert.equal(minor.roastAllowed, false);
        assert.equal(minor.customStyle, null, 'no custom persona style for under-18');
        assert.equal(minor.inferStyle, false);
        assert.equal(minor.frequency, 'rare', 'Gentle frequency');
        assert.deepEqual(minor.styles, GIF_MODE_STYLES.gentle);
    }
});

test('custom persona GIF style: filtered like everything else; only applied with a custom persona', () => {
    for (const ok of ['pirate', '90s cartoons', 'Anime', 'studio ghibli vibes']) assert.equal(validateGifStyle(ok).error, null, ok);
    assert.equal(validateGifStyle('  Pirate  ').value, 'pirate');
    for (const [bad, why] of [['fuck', /profanity/], ['sh1t pirate', /profanity/], ['sexy pirate', /never searched/], ['bloody pirate', /never searched/],
        ['https://evil.example', /letters, numbers/], ['a b c d', /3 words/], ['x'.repeat(31), /30 characters/], ['<script>', /letters, numbers/]]) {
        assert.match(validateGifStyle(bad).error || '', why, bad);
    }
    const settings = validateGifSettings({ custom_style: 'pirate' }).value;
    assert.equal(resolveGifRules({ settings, tone: 'savage', customPersona: true }).customStyle, 'pirate');
    assert.equal(resolveGifRules({ settings, tone: 'savage', customPersona: false }).customStyle, null, 'no custom persona → no style');
    const empty = resolveGifRules({ settings: defaultGifSettings(), tone: 'gentle', customPersona: true });
    assert.equal(empty.inferStyle, true, 'empty style: the AI may suggest one');
    // A bad value already in the database is ignored at runtime.
    assert.equal(resolveGifRules({ settings: { ...defaultGifSettings(), custom_style: 'nsfw pirate' }, tone: 'savage', customPersona: true }).customStyle, null);
    assert.equal(validateGifSettings({ custom_style: 'nude' }).value.custom_style, '');
});

test('queries come only from the style list, plus a style that passed the filters', () => {
    const q = buildGifQuery('mic_drop', { customStyle: 'pirate', rng: () => 0 });
    assert.equal(q, 'mic drop pirate');
    assert.equal(buildGifQuery('mic_drop', { customStyle: 'sexy', rng: () => 0 }), 'mic drop', 'a bad style is dropped, the base query stays');
    assert.equal(buildGifQuery('not_a_style'), null);
    for (const style of Object.keys(GIF_STYLES)) for (let r = 0; r < 1; r += 0.25) assert.ok(buildGifQuery(style, { rng: () => r }));
    // The AI's theme is checked too, and limited to 2 words.
    const infer = resolveGifRules({ settings: defaultGifSettings(), tone: 'savage', customPersona: true });
    assert.equal(decide({ rules: infer, aiTheme: 'pirate' }).query, 'mic drop pirate');
    assert.equal(decide({ rules: infer, aiTheme: 'naked pirate' }).query, 'mic drop');
    assert.equal(decide({ rules: infer, aiTheme: 'very old pirate ships' }).query, 'mic drop');
    assert.equal(decide({ rules: rules(), aiTheme: 'pirate' }).query, 'mic drop', 'no inference without a custom persona');
});

test('frequency per channel and cooldown per member; roast/defend moments skip only the channel count', () => {
    const r = rules();
    assert.deepEqual(decide({ rules: r, repliesSinceGif: 7 }), { send: false, reason: 'channel_frequency' }, 'normal = at most 1 per 8 replies');
    assert.equal(decide({ rules: r, repliesSinceGif: 8 }).send, true);
    const rare = resolveGifRules({ settings: validateGifSettings({ modes: { savage: { frequency: 'rare' } } }).value, tone: 'savage' });
    assert.equal(decide({ rules: rare, repliesSinceGif: 19 }).reason, 'channel_frequency');
    const often = resolveGifRules({ settings: validateGifSettings({ modes: { savage: { frequency: 'often' } } }).value, tone: 'savage' });
    assert.equal(decide({ rules: often, repliesSinceGif: 4 }).send, true);
    const now = 10 ** 12;
    assert.deepEqual(decide({ rules: r, now, lastGifForUserAt: now - 4 * 60 * 1000 }), { send: false, reason: 'user_cooldown' });
    assert.equal(decide({ rules: r, now, lastGifForUserAt: now - 5 * 60 * 1000 }).send, true);
    assert.equal(decide({ rules: r, moment: 'roast', repliesSinceGif: 0 }).send, true, 'roast moments skip the channel count');
    assert.equal(decide({ rules: r, moment: 'roast', repliesSinceGif: 0, now, lastGifForUserAt: now - 1000 }).reason, 'user_cooldown', '…but not the member cooldown');
    assert.deepEqual(decide({ aiStyle: null }), { send: false, reason: 'no_style' }, 'no AI pick in chat = no GIF');
});

test('no GIF for crisis, disabled servers/modes, blocked or non-chat channels, or without GIPHY', () => {
    assert.equal(decide({ isCrisis: true }).reason, 'crisis');
    assert.equal(decide({ providerEnabled: false }).reason, 'no_provider');
    assert.equal(decide({ gifSettings: { ...defaultGifSettings(), enabled: false } }).reason, 'disabled');
    const modeOff = resolveGifRules({ settings: validateGifSettings({ modes: { savage: { enabled: false } } }).value, tone: 'savage' });
    assert.equal(decide({ rules: modeOff }).reason, 'disabled');
    assert.equal(decide({ gifSettings: { ...defaultGifSettings(), blocked_channel_ids: [CH] } }).reason, 'channel_blocked');
    assert.equal(decide({ inChatChannel: false }).reason, 'not_chat_channel', 'default: chat channels only');
    assert.equal(decide({ inChatChannel: false, gifSettings: { ...defaultGifSettings(), channels: 'all' } }).send, true);
});

function fakeChannel({ fail = false } = {}) {
    const sent = [];
    return { id: CH, sent, send: async (payload) => { if (fail) throw Object.assign(new Error('Missing Access'), { code: 50001 }); sent.push(payload); } };
}

test('sending: GIPHY link plus attribution; any failure leaves the text reply alone', async () => {
    let t = 10 ** 12;
    const searches = [];
    const giphy = { enabled: true, search: async (q) => { searches.push(q); return q.includes('pirate') ? null : 'https://giphy.com/gifs/mic-drop-abc123'; } };
    const gifs = createReactionGifs({ giphy, now: () => t, logger: { error() {} }, rng: () => 0 });
    const channel = fakeChannel();
    for (let i = 0; i < 8; i += 1) gifs.noteReply(CH);
    const settings = validateGifSettings({ custom_style: 'pirate' }).value;
    const r = resolveGifRules({ settings, tone: 'savage', customPersona: true });
    const result = await gifs.maybeSend({ channel, guildId: G, userId: AUTHOR, gifSettings: settings, rules: r, inChatChannel: true, aiGif: { style: 'mic_drop' } });
    assert.equal(result.sent, true);
    assert.deepEqual(searches, ['mic drop pirate', 'mic drop'], 'no themed result → retried without the theme');
    assert.deepEqual(channel.sent, [{ content: 'https://giphy.com/gifs/mic-drop-abc123\n-# Powered by GIPHY', allowedMentions: { parse: [] } }]);
    // The counters reset: the next chat GIF needs 8 more replies and the cooldown.
    t += 10 * 60 * 1000;
    assert.equal((await gifs.maybeSend({ channel, guildId: G, userId: AUTHOR, gifSettings: settings, rules: r, inChatChannel: true, aiGif: { style: 'mic_drop' } })).reason, 'channel_frequency');

    const noResult = createReactionGifs({ giphy: { enabled: true, search: async () => null }, logger: { error() {} } });
    const quiet = fakeChannel();
    assert.equal((await noResult.maybeSend({ channel: quiet, guildId: G, userId: AUTHOR, gifSettings: defaultGifSettings(), rules: rules(), inChatChannel: true, moment: 'roast' })).reason, 'no_result');
    assert.deepEqual(quiet.sent, []);

    const logs = [];
    const broken = createReactionGifs({ giphy: { enabled: true, search: async () => 'https://giphy.com/gifs/x-1' }, logger: { error: (m) => logs.push(m) } });
    const failing = fakeChannel({ fail: true });
    assert.equal((await broken.maybeSend({ channel: failing, guildId: G, userId: AUTHOR, gifSettings: defaultGifSettings(), rules: rules(), inChatChannel: true, moment: 'roast' })).reason, 'send_failed');
    assert.deepEqual(logs, ['[ZiGBoT GIF] Send failed: 50001']);
});

test('GIPHY: rating G, safe results only, rate-limit pause and budget, and the key never logged', async () => {
    const KEY = 'giphy-test-key-SECRET-123';
    const calls = [];
    const logs = [];
    let t = 0;
    let respond = () => ({ ok: true, status: 200, json: async () => ({ data: [
        { rating: 'pg', url: 'https://giphy.com/gifs/pg-1' },
        { rating: 'g', url: 'https://evil.example/gifs/x' },
        { rating: 'g', url: 'https://giphy.com/gifs/safe-one-2' }
    ] }) });
    const fetchImpl = async (url) => {
        calls.push(url);
        return respond();
    };
    const giphy = createGiphyClient({ apiKey: KEY, fetchImpl, now: () => t, logger: { error: (m) => logs.push(m) }, budgetPerHour: 3, rng: () => 0 });
    assert.equal(await giphy.search('mic drop'), 'https://giphy.com/gifs/safe-one-2', 'non-G and non-GIPHY results dropped');
    const params = new URL(calls[0]).searchParams;
    assert.equal(params.get('rating'), 'g');
    assert.equal(params.get('q'), 'mic drop');
    assert.equal(new URL(calls[0]).origin + new URL(calls[0]).pathname, 'https://api.giphy.com/v1/gifs/search');
    assert.equal(await giphy.search('sexy dance'), null, 'a blocked query is never sent');
    assert.equal(calls.length, 1);

    respond = () => ({ ok: false, status: 500, json: async () => ({}) });
    assert.equal(await giphy.search('hug'), null);
    respond = () => ({ ok: false, status: 429, json: async () => ({}) });
    assert.equal(await giphy.search('hug'), null);
    respond = () => ({ ok: true, status: 200, json: async () => ({ data: [{ rating: 'g', url: 'https://giphy.com/gifs/a-1' }] }) });
    assert.equal(await giphy.search('hug'), null, 'paused after a 429');
    t += 16 * 60 * 1000;
    assert.equal(await giphy.search('hug'), null, 'hourly budget (3) used up');
    t += 60 * 60 * 1000;
    assert.equal(await giphy.search('hug'), 'https://giphy.com/gifs/a-1');

    const thrower = createGiphyClient({ apiKey: KEY, fetchImpl: async () => { throw new Error(`connect failed for https://api.giphy.com/?api_key=${KEY}`); }, logger: { error: (m) => logs.push(m) } });
    assert.equal(await thrower.search('hug'), null);
    assert.ok(logs.length >= 3);
    for (const line of logs) assert.ok(!line.includes(KEY) && !line.includes('api_key'), `log line leaks the key: ${line}`);
    assert.equal(createGiphyClient({ apiKey: '' }).enabled, false, 'no key → no GIFs');
});

test('bullying: author and target come from code; the bot and the author are never the target', () => {
    const base = { authorId: AUTHOR, botId: BOT };
    const hit = detectBullying({ ...base, text: `<@${TARGET}> you're such a loser`, mentionedIds: [TARGET] });
    assert.deepEqual(hit, { authorId: AUTHOR, targetId: TARGET, severity: 'insult' });
    assert.equal(detectBullying({ ...base, text: `<@${TARGET}> is a clown lol`, mentionedIds: [TARGET] }).targetId, TARGET);
    assert.equal(detectBullying({ ...base, text: 'ur so dumb', repliedToId: TARGET }).targetId, TARGET, 'a reply to a member counts');
    assert.equal(detectBullying({ ...base, text: `<@${BOT}> you're a loser`, mentionedIds: [BOT] }), null, 'insulting the bot is the comeback path, not this');
    assert.equal(detectBullying({ ...base, text: 'I am such a loser lol', mentionedIds: [AUTHOR] }), null, 'never yourself');
    assert.equal(detectBullying({ ...base, text: `<@${AUTHOR}> you're a loser fr`, mentionedIds: [AUTHOR] }), null, 'mentioning yourself is not bullying');
    assert.equal(detectBullying({ ...base, text: `<@${AUTHOR}> <@${TARGET}> you're a loser`, mentionedIds: [AUTHOR, TARGET] }).targetId, TARGET, 'the author is never picked as the target');
    assert.equal(detectBullying({ ...base, text: `this game is stupid <@${TARGET}>`, mentionedIds: [TARGET] }), null, 'not aimed at a person');
    assert.equal(detectBullying({ ...base, text: `<@${TARGET}> gg well played`, mentionedIds: [TARGET] }), null);
    assert.equal(detectBullying({ ...base, text: `<@${TARGET}> kys`, mentionedIds: [TARGET] }).severity, 'severe');
    assert.equal(detectBullying({ ...base, text: `<@${TARGET}> you retard`, mentionedIds: [TARGET] }).severity, 'severe', 'slurs are severe');
});

test('bullying replies back the target and never roast them', () => {
    for (const savage of [true, false]) {
        const text = buildBullyInstruction({ authorName: 'mean_kid', targetName: 'shy_sam', savage });
        assert.match(text, /mean_kid just insulted shy_sam\. You are on shy_sam's side\./);
        assert.match(text, /Never insult or tease shy_sam in any way\./);
        assert.match(text, /never about who mean_kid is \(no appearance, race, religion/);
        assert.doesNotMatch(text, /roast[^.]*shy_sam/i, 'the target is never the one roasted');
        if (savage) assert.match(text, /roast of what they said/);
        else assert.match(text, /Do not roast anyone/);
    }
    // Names from members can't inject mentions or markdown.
    const sneaky = buildBullyInstruction({ authorName: '@everyone`**', targetName: '<@123>', savage: true });
    assert.doesNotMatch(sneaky, /@everyone|<@|`|\*\*/);
    assert.doesNotMatch(severeReplyText('<@&999>'), /<@/);
});

test('repeat bullying suggests a mod action (never an automatic punishment)', () => {
    let t = 0;
    const tracker = createBullyTracker({ now: () => t });
    assert.deepEqual([1, 2, 3].map(() => tracker.record(G, AUTHOR)), [1, 2, 3]);
    assert.equal(tracker.threshold, 3);
    t += 61 * 60 * 1000;
    assert.equal(tracker.record(G, AUTHOR), 1, 'the window moves on');
    const line = modSuggestion({ authorName: 'mean_kid', count: 3 });
    assert.match(line, /Mods: mean\\_kid has gone after other members 3 times in the last hour\. A warning might help\. \(Nothing was done automatically\.\)/);
    assert.doesNotMatch(line, /<@/);
});

test('the AI GIF tag: only allowed styles, always stripped, never shown', () => {
    const gentle = { styles: GIF_MODE_STYLES.gentle, inferStyle: false };
    assert.deepEqual(parseGifTag('aww that is sweet\n[gif: hug]', gentle), { text: 'aww that is sweet', style: 'hug', theme: null });
    assert.deepEqual(parseGifTag('lol\n[gif: mic_drop]', gentle), { text: 'lol', style: null, theme: null }, 'a roast pick in Gentle is ignored');
    assert.deepEqual(parseGifTag('ahoy\n[gif: cheer | pirate]', { styles: ['cheer'], inferStyle: true }), { text: 'ahoy', style: 'cheer', theme: 'pirate' });
    assert.deepEqual(parseGifTag('ok [gif: hug | pirate]', gentle).theme, null, 'no theme unless inference is on');
    assert.equal(parseGifTag('nothing to see [gif: hug]', null).text, 'nothing to see', 'stripped even when no GIF was asked for');
    const block = gifPromptBlock(gentle);
    assert.match(block, /one of: hug, cheer, clap, thumbs_up, laugh\./);
    assert.ok(!ROAST.some((s) => block.includes(s)), 'Gentle prompt never offers roast styles');
    assert.equal(gifPromptBlock(null), '');
    assert.equal(gifPromptBlock({ styles: [] }), '');
});

test('Premium gating: a custom persona GIF style needs Premium; free servers keep Gentle/Neutral/Savage settings', () => {
    const config = sanitizeStoredConfig({ guild_id: G, custom_system_prompt: 'You are a pirate.', gif_settings: { custom_style: 'pirate', modes: { savage: { frequency: 'rare' } } } }, { guildId: G });
    const free = applyPlanToConfig(config, false);
    assert.equal(free.gif_settings.custom_style, '');
    assert.equal(free.gif_settings.modes.savage.frequency, 'rare', 'the rest of the GIF settings still apply');
    assert.equal(applyPlanToConfig(config, true).gif_settings.custom_style, 'pirate');
    const freeRules = resolveGifRules({ settings: free.gif_settings, tone: 'savage', customPersona: Boolean(false && free.custom_system_prompt) });
    assert.equal(freeRules.customStyle, null);
    assert.deepEqual(configPremiumErrors({ gif_custom_style: 'pirate' }), { gif_settings: 'A custom persona GIF style needs ZiGBoT Premium for this server.' });
    assert.deepEqual(configPremiumErrors({ gif_custom_style: '' }), {});
});

test('the guild config carries validated GIF settings', () => {
    const ok = validateGuildConfig({ gif_settings: { enabled: false, channels: 'all' } }, { guildId: G });
    assert.equal(ok.ok, true);
    assert.equal(ok.value.gif_settings.enabled, false);
    assert.equal(ok.value.gif_settings.channels, 'all');
    const bad = validateGuildConfig({ gif_settings: { custom_style: 'fuck it', blocked_channel_ids: ['999999999999999999'] } }, { guildId: G, channelIds: new Set([CH]) });
    assert.equal(bad.ok, false);
    assert.match(bad.errors.gif_settings, /GIF style contains profanity/);
    assert.match(bad.errors.gif_settings, /not channels of this server/);
    assert.deepEqual(sanitizeStoredConfig({ guild_id: G }, { guildId: G }).gif_settings, defaultGifSettings(), 'old rows get the defaults');
    assert.deepEqual(sanitizeStoredConfig({ guild_id: G, gif_settings: 'garbage' }, { guildId: G }).gif_settings, defaultGifSettings());
});

test('wiring: crisis first, bullying after tool routing, GIFs only after the text, /setup options, key from env', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const index = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');
    const handler = index.slice(index.indexOf('client.on(Events.MessageCreate'));
    const at = (needle) => {
        const i = handler.indexOf(needle);
        assert.ok(i >= 0, `missing: ${needle}`);
        return i;
    };
    assert.ok(at('if (isCrisisMessage(userMessage))') < at('const bullying = '), 'crisis is handled before any bullying reply or GIF');
    assert.ok(at('await runIntent(message, gSettings, intent') < at('const bullying = '), 'commands (warn, kick…) are routed first');
    assert.ok(at('await deliverAiReply(message, replyText') < at('await reactionGifs.maybeSend('), 'the GIF only follows the text reply');
    assert.match(handler, /gif: gifRules\.enabled && !declineMode \?/);
    const voice = index.slice(index.indexOf('async function handleVoiceTranscript'));
    assert.doesNotMatch(voice.slice(0, voice.indexOf('\n}\n')), /reactionGifs/, 'no GIFs from voice chat');
    const setup = require('../src/slash').buildDefinitions().find((d) => d.name === 'setup');
    const options = Object.fromEntries(setup.options.map((o) => [o.name, o]));
    assert.equal(options.gifs.required, false);
    assert.deepEqual(options.gif_frequency.choices.map((c) => c.value), ['rare', 'normal', 'often']);
    assert.match(options.roast_gifs.description, /Gentle never roasts/);
    assert.match(fs.readFileSync(path.join(__dirname, '..', 'src', 'config', 'settings.js'), 'utf8'), /giphyApiKey: \(process\.env\.GIPHY_API_KEY \|\| ''\)\.trim\(\)/);
});

test('the Privacy page names GIPHY and says it only gets ZiGBoT\'s own search words', () => {
    const privacy = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'dashboard', 'app', 'privacy', 'page.js'), 'utf8');
    assert.match(privacy, /<strong>GIPHY<\/strong>: reaction GIF searches\. It receives only ZiGBoT&apos;s own short search words/);
});
