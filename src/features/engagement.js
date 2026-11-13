/**
 * Section G, Engagement (docs/ZIGBOT_FEATURE_MATRIX.md). Off until a server
 * switches it on (feature_settings.engagement). Virtual coins only: they
 * cannot be bought, sold or cashed out, and no game stakes them.
 *
 *   messages      -> XP (15-25, once a minute, not in ignored channels) and levels
 *   /level        -> rank (card image), leaderboard (paginated)
 *   /eco          -> daily, balance, shop, buy, inventory, achievements, trade
 *   /games        -> trivia, coinflip, rps
 *   /giveaway     -> start, end, reroll (button entry, optional required role)
 *   /tournament   -> create (sign-ups), start (bracket), win, show
 *
 * Member data is one record per member (kind "member"); every change goes
 * through store.mutate, so concurrent messages, buys or trades never lose
 * or duplicate coins. A trade is claimed once, then each side is taken
 * with a check, and the first side is refunded if the second check fails.
 */
const crypto = require('node:crypto');
const { PermissionFlagsBits } = require('discord.js');
const { NO_PINGS, sectionOf, safeText, memberCan, roleProblem, reply, makeAudit } = require('./common');
const rules = require('./engagementRules');

const PREFIX = 'zbg:';
const SNOWFLAKE = /^\d{17,20}$/;
const TRADE_TTL_MS = 5 * 60_000;
const TRIVIA_MS = 30_000;
const MAX_ENTRANTS = 10_000;

function createEngagement({ store, scheduler, resolveContext, auditLog, getClient = () => null, now = () => Date.now(), rng = Math.random, randomInt = crypto.randomInt, renderRankCard = null, setTimer = (fn, ms) => setTimeout(fn, ms).unref?.(), logger = console }) {
    const audit = makeAudit({ auditLog, logger, event: 'ENGAGEMENT' });
    const lastXp = new Map(); // `${guild}:${user}` -> time, saves a storage read per message
    const trivia = new Map(); // game id -> live round
    const fail = (what, error) => logger.error?.(`[ZiGBoT ENGAGEMENT] ${what} failed: ${error?.code || error?.message || error}`);
    const coinsText = (e, n) => `**${n.toLocaleString('en-US')}** ${safeText(e.currency_name, 20)}`;

    async function ctxFor(guild) {
        const context = await resolveContext(guild);
        if (context?.config?.enabled === false) return null;
        return { settings: context?.settings || {}, e: sectionOf(context?.config, 'engagement') };
    }

    const getMember = async (guildId, userId) => ({ ...rules.blankMember(), ...(await store.get(guildId, 'member', userId))?.data });
    const changeMember = (guildId, userId, fn) => store.mutate(guildId, 'member', userId, (data) => fn({ ...rules.blankMember(), ...(data || {}) }));

    // ------------------------------------------------------------------ XP
    async function onMessage(message) {
        if (!message?.guild || message.author?.bot || message.webhookId || message.system) return false;
        const key = `${message.guild.id}:${message.author.id}`;
        const t = now();
        if (t - (lastXp.get(key) || 0) < rules.XP_COOLDOWN_MS) return false;
        const ctx = await ctxFor(message.guild);
        if (!ctx?.e.xp_enabled) return false;
        const channelId = message.channel?.id;
        if (ctx.e.xp_ignored_channel_ids.includes(channelId) || ctx.e.xp_ignored_channel_ids.includes(message.channel?.parentId)) return false;
        lastXp.set(key, t);
        if (lastXp.size > 50_000) lastXp.clear();

        let levelUp = null;
        let earned = [];
        await changeMember(message.guild.id, message.author.id, (m) => {
            if (t - m.lastXpAt < rules.XP_COOLDOWN_MS) return undefined; // another worker already counted it
            const before = rules.levelFromXp(m.xp).level;
            m.xp += rules.rollXp(rng);
            m.messages += 1;
            m.lastXpAt = t;
            const after = rules.levelFromXp(m.xp).level;
            levelUp = after > before ? after : null;
            earned = ctx.e.achievements_enabled ? rules.newAchievements(m) : [];
            m.achievements = [...m.achievements, ...earned.map((a) => a.id)];
            return m;
        });
        if (levelUp !== null || earned.length) {
            const lines = [];
            if (levelUp !== null) lines.push(`🎉 <@${message.author.id}> reached **level ${levelUp}**!`);
            for (const a of earned) lines.push(`${a.emoji} <@${message.author.id}> unlocked **${a.name}**!`);
            const target = (ctx.e.levelup_channel_id && message.guild.channels?.cache?.get?.(ctx.e.levelup_channel_id)) || message.channel;
            await target?.send?.({ content: lines.join('\n'), allowedMentions: { parse: [], users: [message.author.id] } }).catch((error) => fail('level-up', error));
        }
        return false; // XP never stops the normal bot flow
    }

    // --------------------------------------------------------------- /level
    async function leaderboard(guildId) {
        const rows = await store.list(guildId, 'member', { limit: 1000 });
        return rows.map((r) => ({ userId: r.key, ...rules.blankMember(), ...r.data })).sort((a, b) => b.xp - a.xp || a.userId.localeCompare(b.userId));
    }

    async function level(interaction, guild, e) {
        if (!e.xp_enabled) return reply(interaction, '❌ XP and levels are switched off in this server.');
        const sub = interaction.options.getSubcommand();
        if (sub === 'leaderboard') {
            const board = await leaderboard(guild.id);
            const pages = Math.max(1, Math.ceil(board.length / 10));
            const page = Math.min(Math.max(interaction.options.getInteger('page') || 1, 1), pages);
            const lines = board.slice((page - 1) * 10, page * 10).map((m, i) => `**${(page - 1) * 10 + i + 1}.** <@${m.userId}> · level ${rules.levelFromXp(m.xp).level} · ${m.xp.toLocaleString('en-US')} XP`);
            return reply(interaction, lines.length ? `🏆 **Leaderboard** (page ${page}/${pages})\n${lines.join('\n')}` : 'Nobody has XP yet.');
        }
        const user = interaction.options.getUser('member') || interaction.user;
        const m = await getMember(guild.id, user.id);
        const board = await leaderboard(guild.id);
        const rank = board.findIndex((r) => r.userId === user.id) + 1 || null;
        const progress = rules.levelFromXp(m.xp);
        const text = `📈 <@${user.id}> · level **${progress.level}** · ${progress.into}/${progress.needed} XP to the next level · rank ${rank ? `#${rank}` : 'unranked'} · ${m.messages} messages`;
        let files;
        if (renderRankCard) {
            const png = await Promise.resolve().then(() => renderRankCard({ name: interaction.options.getMember?.('member')?.displayName || user.globalName || user.username, level: progress.level, into: progress.into, needed: progress.needed, rank })).catch((error) => { fail('rank card', error); return null; });
            if (png) files = [{ attachment: png, name: 'rank.png' }];
        }
        return reply(interaction, { content: text, ...(files ? { files } : {}) });
    }

    // ----------------------------------------------------------------- /eco
    const findItem = (e, name) => e.shop_items.find((i) => i.name.trim().toLowerCase() === String(name || '').trim().toLowerCase()) || null;

    async function eco(interaction, guild, e, settings) {
        if (!e.economy_enabled) return reply(interaction, '❌ The economy is switched off in this server.');
        const sub = interaction.options.getSubcommand();
        const userId = interaction.user.id;
        if (sub === 'balance') {
            const user = interaction.options.getUser('member') || interaction.user;
            return reply(interaction, `💰 <@${user.id}> has ${coinsText(e, (await getMember(guild.id, user.id)).coins)}.`);
        }
        if (sub === 'daily') {
            const t = now();
            let result = null;
            await changeMember(guild.id, userId, (m) => {
                if (t - m.lastDailyAt < rules.DAILY_MS) { result = { wait: m.lastDailyAt + rules.DAILY_MS }; return undefined; }
                m.streak = t - m.lastDailyAt <= rules.STREAK_GRACE_MS ? m.streak + 1 : 1;
                m.lastDailyAt = t;
                m.coins = Math.min(rules.COIN_CAP, m.coins + e.daily_amount);
                const earned = e.achievements_enabled ? rules.newAchievements(m) : [];
                m.achievements = [...m.achievements, ...earned.map((a) => a.id)];
                result = { coins: m.coins, streak: m.streak, earned };
                return m;
            });
            if (result.wait) return reply(interaction, `⏳ You already claimed today. Come back <t:${Math.floor(result.wait / 1000)}:R>.`);
            return reply(interaction, [`✅ +${coinsText(e, e.daily_amount)}. You now have ${coinsText(e, result.coins)} · streak **${result.streak}** day${result.streak === 1 ? '' : 's'}.`, ...result.earned.map((a) => `${a.emoji} Unlocked **${a.name}**!`)].join('\n'));
        }
        if (sub === 'shop') {
            if (!e.shop_items.length) return reply(interaction, '🛒 The shop is empty. Admins add items in the dashboard (Add-ons → Engagement).');
            return reply(interaction, `🛒 **Shop**\n${e.shop_items.map((i) => `${safeText(i.emoji, 16)} **${safeText(i.name, 40)}** · ${coinsText(e, i.price)}${i.role_id ? ` · gives <@&${i.role_id}>` : ''}`).join('\n')}`);
        }
        if (sub === 'buy') {
            const item = findItem(e, interaction.options.getString('item'));
            if (!item) return reply(interaction, '❌ There is no item with that name in the shop.');
            const role = item.role_id ? guild.roles?.cache?.get?.(item.role_id) : null;
            const problem = item.role_id ? roleProblem(guild, role) : null;
            if (problem) return reply(interaction, `❌ This item gives a role I cannot hand out: ${problem}`);
            let short = false;
            await changeMember(guild.id, userId, (m) => {
                if (m.coins < item.price) { short = true; return undefined; }
                m.coins -= item.price;
                m.inventory[item.name] = (m.inventory[item.name] || 0) + 1;
                return m;
            });
            if (short) return reply(interaction, `❌ ${safeText(item.name, 40)} costs ${coinsText(e, item.price)}. You do not have enough.`);
            if (role) await interaction.member.roles.add(role, 'Shop purchase').catch((error) => fail('shop role', error));
            await audit(interaction, settings, { action: 'shop_buy', target: item.name, details: { price: item.price } });
            return reply(interaction, `✅ You bought ${safeText(item.emoji, 16)} **${safeText(item.name, 40)}**${role ? ` and got the ${role.name} role` : ''}.`);
        }
        if (sub === 'inventory') {
            const user = interaction.options.getUser('member') || interaction.user;
            const m = await getMember(guild.id, user.id);
            const items = Object.entries(m.inventory).filter(([, n]) => n > 0);
            return reply(interaction, items.length ? `🎒 <@${user.id}>\n${items.map(([name, n]) => `• ${safeText(name, 40)} × ${n}`).join('\n')}` : `🎒 <@${user.id}> has no items yet.`);
        }
        if (sub === 'achievements') {
            if (!e.achievements_enabled) return reply(interaction, '❌ Achievements are switched off in this server.');
            const m = await getMember(guild.id, interaction.user.id);
            return reply(interaction, `🏅 **Achievements** (${m.achievements.length}/${rules.ACHIEVEMENTS.length})\n${rules.ACHIEVEMENTS.map((a) => `${m.achievements.includes(a.id) ? a.emoji : '🔒'} ${a.name}`).join('\n')}`);
        }
        if (sub === 'trade') return proposeTrade(interaction, guild, e);
        return reply(interaction, '❌ Unknown option.');
    }

    // --------------------------------------------------------------- trading
    const side = (coins, item) => ({ coins: Math.max(0, coins || 0), item: item ? item.name : null });
    const describe = (e, s) => [s.coins ? coinsText(e, s.coins) : null, s.item ? `**${safeText(s.item, 40)}**` : null].filter(Boolean).join(' + ') || 'nothing';
    const hasSide = (m, s) => m.coins >= s.coins && (!s.item || (m.inventory[s.item] || 0) >= 1);
    const take = (m, s) => { m.coins -= s.coins; if (s.item) m.inventory[s.item] -= 1; return m; };
    const give = (m, s) => { m.coins = Math.min(rules.COIN_CAP, m.coins + s.coins); if (s.item) m.inventory[s.item] = (m.inventory[s.item] || 0) + 1; return m; };

    async function proposeTrade(interaction, guild, e) {
        const target = interaction.options.getUser('member');
        if (!target || target.bot || target.id === interaction.user.id) return reply(interaction, '❌ Pick another member (not yourself, not a bot).');
        const giveItemName = interaction.options.getString('give_item');
        const wantItemName = interaction.options.getString('want_item');
        const giveItem = giveItemName ? findItem(e, giveItemName) : null;
        const wantItem = wantItemName ? findItem(e, wantItemName) : null;
        if ((giveItemName && !giveItem) || (wantItemName && !wantItem)) return reply(interaction, '❌ Items must be shop items of this server.');
        const offer = side(interaction.options.getInteger('give_coins'), giveItem);
        const ask = side(interaction.options.getInteger('want_coins'), wantItem);
        if (!offer.coins && !offer.item && !ask.coins && !ask.item) return reply(interaction, '❌ Offer or ask for something.');
        if (!hasSide(await getMember(guild.id, interaction.user.id), offer)) return reply(interaction, '❌ You do not have what you are offering.');
        const key = crypto.randomUUID();
        await store.put(guild.id, 'trade', key, { from: interaction.user.id, to: target.id, offer, ask, status: 'pending', expiresAt: now() + TRADE_TTL_MS });
        await interaction.channel.send({
            content: `🤝 <@${target.id}>, <@${interaction.user.id}> offers ${describe(e, offer)} for ${describe(e, ask)}. This offer ends <t:${Math.floor((now() + TRADE_TTL_MS) / 1000)}:R>.`,
            components: [{ type: 1, components: [
                { type: 2, style: 3, label: 'Accept', custom_id: `${PREFIX}tr:accept:${key}` },
                { type: 2, style: 4, label: 'Decline', custom_id: `${PREFIX}tr:decline:${key}` }
            ] }],
            allowedMentions: { parse: [], users: [target.id] }
        });
        return reply(interaction, '✅ Trade offer sent. It completes only if they accept.');
    }

    async function tradeButton(interaction, guild, e, settings, action, key) {
        const userId = interaction.user.id;
        let outcome = null;
        // Claim: pending -> executing, once, by the right person, before it expires.
        await store.mutate(guild.id, 'trade', key, (t) => {
            if (!t) { outcome = 'gone'; return undefined; }
            if (t.status !== 'pending') { outcome = 'done'; return undefined; }
            if (action === 'accept' && userId !== t.to) { outcome = 'notyou'; return undefined; }
            if (action === 'decline' && userId !== t.to && userId !== t.from) { outcome = 'notyou'; return undefined; }
            if (now() > t.expiresAt) { t.status = 'expired'; outcome = 'expired'; return t; }
            t.status = action === 'accept' ? 'executing' : 'declined';
            outcome = t.status;
            return t;
        });
        if (outcome === 'gone') return reply(interaction, '❌ This trade no longer exists.');
        if (outcome === 'done') return reply(interaction, 'This trade is already finished.');
        if (outcome === 'notyou') return reply(interaction, '❌ This trade is not yours to answer.');
        const finish = async (status, text) => {
            await store.mutate(guild.id, 'trade', key, (t) => ({ ...t, status }));
            await interaction.message?.edit?.({ components: [] }).catch(() => {});
            await audit(interaction, settings, { action: 'trade', target: key, result: status === 'done' ? 'SUCCESS' : status.toUpperCase() });
            return reply(interaction, text);
        };
        if (outcome === 'expired') return finish('expired', '⌛ This trade offer has expired.');
        if (outcome === 'declined') return finish('declined', '❌ Trade declined.');

        const t = (await store.get(guild.id, 'trade', key)).data;
        let ok = true;
        await changeMember(guild.id, t.from, (m) => (hasSide(m, t.offer) ? take(m, t.offer) : ((ok = false), undefined)));
        if (!ok) return finish('failed', `❌ <@${t.from}> no longer has what they offered. Nothing changed.`);
        await changeMember(guild.id, t.to, (m) => (hasSide(m, t.ask) ? take(m, t.ask) : ((ok = false), undefined)));
        if (!ok) {
            await changeMember(guild.id, t.from, (m) => give(m, t.offer)); // refund: neither side moves
            return finish('failed', '❌ You do not have what they asked for. Nothing changed.');
        }
        await changeMember(guild.id, t.from, (m) => give(m, t.ask));
        await changeMember(guild.id, t.to, (m) => give(m, t.offer));
        return finish('done', `✅ Trade complete: <@${t.from}> got ${describe(e, t.ask)}, <@${t.to}> got ${describe(e, t.offer)}.`);
    }

    // ----------------------------------------------------------------- /games
    async function games(interaction, guild, e) {
        if (!e.games_enabled) return reply(interaction, '❌ Games are switched off in this server.');
        const sub = interaction.options.getSubcommand();
        if (sub === 'coinflip') return reply(interaction, `🪙 ${randomInt(2) === 0 ? 'Heads' : 'Tails'}!`);
        if (sub === 'rps') {
            const choice = interaction.options.getString('choice');
            if (!rules.RPS.includes(choice)) return reply(interaction, '❌ Pick rock, paper or scissors.');
            const bot = rules.RPS[randomInt(3)];
            const result = rules.rpsResult(choice, bot);
            return reply(interaction, `✊ You: **${choice}** · ZiGBoT: **${bot}** · ${result === 'win' ? 'You win! 🎉' : result === 'lose' ? 'I win! 😎' : 'Draw.'}`);
        }
        if (sub === 'trivia') {
            const round = rules.triviaRound(randomInt);
            const id = crypto.randomUUID().slice(0, 8);
            const message = await interaction.channel.send({
                content: `🧠 **Trivia** (${TRIVIA_MS / 1000} s): ${round.question}`,
                components: [{ type: 1, components: round.answers.map((answer, i) => ({ type: 2, style: 1, label: answer.slice(0, 80), custom_id: `${PREFIX}tv:${id}:${i}` })) }],
                allowedMentions: NO_PINGS
            });
            trivia.set(id, { ...round, guildId: guild.id, endsAt: now() + TRIVIA_MS, answered: new Set(), winner: null, message, reward: e.economy_enabled ? e.trivia_reward : 0 });
            setTimer(() => closeTrivia(id), TRIVIA_MS + 500);
            return reply(interaction, '✅ Trivia started.');
        }
        return reply(interaction, '❌ Unknown option.');
    }

    async function closeTrivia(id) {
        const round = trivia.get(id);
        if (!round) return;
        trivia.delete(id);
        if (!round.winner) await round.message?.edit?.({ content: `🧠 Time is up! The answer was **${round.answers[round.correctIndex]}**.`, components: [] }).catch(() => {});
    }

    async function triviaButton(interaction, guild, e, id, index) {
        const round = trivia.get(id);
        if (!round || round.guildId !== guild.id || now() > round.endsAt) return reply(interaction, '⌛ This trivia round is over.');
        if (round.answered.has(interaction.user.id)) return reply(interaction, 'You already answered.');
        round.answered.add(interaction.user.id);
        if (Number(index) !== round.correctIndex) return reply(interaction, '❌ Not quite.');
        if (round.winner) return reply(interaction, 'Correct, but someone was faster!');
        round.winner = interaction.user.id;
        trivia.delete(id);
        if (round.reward) await changeMember(guild.id, interaction.user.id, (m) => give(m, { coins: round.reward, item: null }));
        await round.message?.edit?.({ content: `🧠 <@${interaction.user.id}> got it: **${round.answers[round.correctIndex]}**!${round.reward ? ` +${coinsText(e, round.reward)}` : ''}`, components: [], allowedMentions: NO_PINGS }).catch(() => {});
        return reply(interaction, '✅ Correct!');
    }

    // ------------------------------------------------------------- giveaways
    const giveawayText = (g) => `🎁 **GIVEAWAY: ${safeText(g.prize, 200)}**\n${g.ended ? `Ended. Winner${g.winnerIds.length === 1 ? '' : 's'}: ${g.winnerIds.length ? g.winnerIds.map((id) => `<@${id}>`).join(', ') : 'nobody entered'}` : `Ends <t:${Math.floor(g.endsAt / 1000)}:R> · ${g.winners} winner${g.winners === 1 ? '' : 's'}${g.requiredRoleId ? ` · needs <@&${g.requiredRoleId}>` : ''} · ${g.entrants.length} entered`}`;
    const enterButton = (open) => (open ? [{ type: 1, components: [{ type: 2, style: 1, label: 'Enter / leave', emoji: { name: '🎉' }, custom_id: `${PREFIX}ga:enter` }] }] : []);

    async function endGiveaway(guildId, messageId, { reroll = false } = {}) {
        let result = null;
        await store.mutate(guildId, 'giveaway', messageId, (g) => {
            if (!g) return undefined;
            if (!reroll && g.ended) return undefined;
            if (reroll && !g.ended) return undefined;
            const pool = reroll ? g.entrants.filter((id) => !g.winnerIds.includes(id)) : g.entrants;
            g.winnerIds = rules.pickWinners(pool, g.winners, randomInt);
            g.ended = true;
            result = g;
            return g;
        });
        if (!result) return null;
        const guild = getClient()?.guilds?.cache?.get?.(guildId);
        const channel = guild?.channels?.cache?.get?.(result.channelId);
        if (channel) {
            const message = await channel.messages?.fetch?.(messageId).catch(() => null);
            await message?.edit?.({ content: giveawayText(result), components: [], allowedMentions: NO_PINGS }).catch(() => {});
            await channel.send({ content: result.winnerIds.length ? `🎉 ${reroll ? 'New winner' : 'Congratulations'}${result.winnerIds.length === 1 ? '' : 's'} ${result.winnerIds.map((id) => `<@${id}>`).join(', ')}! You won **${safeText(result.prize, 200)}**.` : `🎁 Nobody entered the giveaway for **${safeText(result.prize, 200)}**.`, allowedMentions: { parse: [], users: result.winnerIds } }).catch((error) => fail('giveaway result', error));
        }
        return result;
    }
    scheduler.register('giveaway_end', ({ guildId, payload }) => endGiveaway(guildId, payload.messageId).then(() => null));

    async function giveaway(interaction, guild, e, settings) {
        if (!e.giveaways_enabled) return reply(interaction, '❌ Giveaways are switched off in this server.');
        if (!memberCan(interaction.member, PermissionFlagsBits.ManageGuild)) {
            await audit(interaction, settings, { action: 'giveaway', result: 'DENIED', details: { reason: 'missing Manage Server' } });
            return reply(interaction, '❌ You need the Manage Server permission.');
        }
        const sub = interaction.options.getSubcommand();
        if (sub === 'start') {
            const minutes = interaction.options.getInteger('minutes');
            const winners = interaction.options.getInteger('winners') || 1;
            if (!Number.isInteger(minutes) || minutes < 1 || minutes > 43200) return reply(interaction, '❌ Minutes must be from 1 to 43200 (30 days).');
            if (winners < 1 || winners > 10) return reply(interaction, '❌ 1 to 10 winners.');
            const role = interaction.options.getRole('required_role');
            const g = { prize: safeText(interaction.options.getString('prize'), 200), endsAt: now() + minutes * 60_000, winners, requiredRoleId: role?.id || null, entrants: [], winnerIds: [], ended: false, channelId: interaction.channel.id, host: interaction.user.id };
            const message = await interaction.channel.send({ content: giveawayText(g), components: enterButton(true), allowedMentions: NO_PINGS });
            await store.put(guild.id, 'giveaway', message.id, g);
            await scheduler.schedule(guild.id, 'giveaway_end', { messageId: message.id }, g.endsAt, { key: `giveaway-${message.id}` });
            await audit(interaction, settings, { action: 'giveaway_start', target: message.id, details: { minutes, winners } });
            return reply(interaction, '✅ Giveaway started.');
        }
        const messageId = String(interaction.options.getString('message_id') || '').trim();
        if (!SNOWFLAKE.test(messageId)) return reply(interaction, '❌ Give the giveaway message ID (right-click the message → Copy Message ID).');
        const result = await endGiveaway(guild.id, messageId, { reroll: sub === 'reroll' });
        if (sub === 'end') await scheduler.cancel(guild.id, `giveaway-${messageId}`).catch(() => {});
        await audit(interaction, settings, { action: `giveaway_${sub}`, target: messageId, result: result ? 'SUCCESS' : 'FAILED' });
        return reply(interaction, result ? `✅ Done. Winner${result.winnerIds.length === 1 ? '' : 's'}: ${result.winnerIds.map((id) => `<@${id}>`).join(', ') || 'nobody'}.` : sub === 'reroll' ? '❌ No ended giveaway with that message ID.' : '❌ No running giveaway with that message ID.');
    }

    async function giveawayButton(interaction, guild) {
        let outcome = null;
        const { record } = await store.mutate(guild.id, 'giveaway', interaction.message.id, (g) => {
            if (!g) { outcome = 'gone'; return undefined; }
            if (g.ended || now() > g.endsAt) { outcome = 'ended'; return undefined; }
            if (g.requiredRoleId && !interaction.member.roles?.cache?.has?.(g.requiredRoleId)) { outcome = 'role'; return undefined; }
            if (g.entrants.includes(interaction.user.id)) { g.entrants = g.entrants.filter((id) => id !== interaction.user.id); outcome = 'left'; }
            else {
                if (g.entrants.length >= MAX_ENTRANTS) { outcome = 'full'; return undefined; }
                g.entrants.push(interaction.user.id);
                outcome = 'entered';
            }
            return g;
        });
        if (outcome === 'gone') return reply(interaction, '❌ This giveaway is no longer tracked.');
        if (outcome === 'ended') return reply(interaction, 'This giveaway has ended.');
        if (outcome === 'role') return reply(interaction, '❌ You need the required role to enter.');
        if (outcome === 'full') return reply(interaction, '❌ This giveaway is full.');
        await interaction.message.edit?.({ content: giveawayText(record.data), components: enterButton(true), allowedMentions: NO_PINGS }).catch(() => {});
        return reply(interaction, outcome === 'entered' ? '🎉 You are in! Good luck.' : 'You left the giveaway.');
    }

    // ----------------------------------------------------------- tournaments
    function bracketText(tn) {
        const name = (id) => (id ? `<@${id}>` : '*bye*');
        const lines = [`🏆 **${safeText(tn.name, 100)}** · ${tn.status === 'signup' ? `${tn.players.length}/${tn.max} signed up` : tn.status}`];
        if (tn.bracket) {
            tn.bracket.rounds.forEach((round, r) => {
                lines.push(`__Round ${r + 1}__`);
                round.forEach((m) => lines.push(`${name(m.a)} vs ${name(m.b)}${m.winner ? ` → **${m.a === m.winner ? name(m.a) : name(m.b)}**` : ''}`));
            });
            if (tn.bracket.champion) lines.push(`👑 Champion: <@${tn.bracket.champion}>`);
        } else if (tn.players.length) {
            lines.push(tn.players.map((id) => `<@${id}>`).join(', '));
        }
        return lines.join('\n').slice(0, 1900);
    }
    const signupButtons = (open) => (open ? [{ type: 1, components: [
        { type: 2, style: 3, label: 'Join', custom_id: `${PREFIX}to:join` },
        { type: 2, style: 2, label: 'Leave', custom_id: `${PREFIX}to:leave` }
    ] }] : []);

    async function tournament(interaction, guild, e, settings) {
        if (!e.tournaments_enabled) return reply(interaction, '❌ Tournaments are switched off in this server.');
        const sub = interaction.options.getSubcommand();
        if (sub !== 'show' && !memberCan(interaction.member, PermissionFlagsBits.ManageEvents)) {
            await audit(interaction, settings, { action: `tournament_${sub}`, result: 'DENIED', details: { reason: 'missing Manage Events' } });
            return reply(interaction, '❌ You need the Manage Events permission.');
        }
        if (sub === 'create') {
            const max = interaction.options.getInteger('max_players') || 16;
            if (max < 2 || max > 32) return reply(interaction, '❌ 2 to 32 players.');
            const tn = { name: safeText(interaction.options.getString('name'), 100), max, players: [], status: 'signup', bracket: null, channelId: interaction.channel.id };
            const message = await interaction.channel.send({ content: bracketText(tn), components: signupButtons(true), allowedMentions: NO_PINGS });
            await store.put(guild.id, 'tournament', message.id, tn);
            await audit(interaction, settings, { action: 'tournament_create', target: message.id });
            return reply(interaction, '✅ Sign-ups are open.');
        }
        const messageId = String(interaction.options.getString('message_id') || '').trim();
        if (!SNOWFLAKE.test(messageId)) return reply(interaction, '❌ Give the tournament message ID.');
        if (sub === 'show') {
            const tn = (await store.get(guild.id, 'tournament', messageId))?.data;
            return reply(interaction, tn ? bracketText(tn) : '❌ No tournament with that message ID.');
        }
        let problem = null;
        const { record } = await store.mutate(guild.id, 'tournament', messageId, (tn) => {
            if (!tn) { problem = 'No tournament with that message ID.'; return undefined; }
            try {
                if (sub === 'start') {
                    if (tn.status !== 'signup') throw new Error('It has already started.');
                    tn.bracket = rules.buildBracket(tn.players, randomInt);
                    tn.status = 'running';
                } else {
                    if (tn.status !== 'running') throw new Error('It is not running.');
                    const winner = interaction.options.getUser('player')?.id;
                    rules.reportWinner(tn.bracket, winner);
                    if (tn.bracket.champion) tn.status = 'finished';
                }
            } catch (error) {
                problem = error.message;
                return undefined;
            }
            return tn;
        });
        if (problem) return reply(interaction, `❌ ${problem}`);
        const channel = guild.channels?.cache?.get?.(record.data.channelId);
        await channel?.send?.({ content: bracketText(record.data), allowedMentions: NO_PINGS }).catch((error) => fail('bracket post', error));
        await audit(interaction, settings, { action: `tournament_${sub}`, target: messageId });
        return reply(interaction, sub === 'start' ? '✅ Bracket posted.' : '✅ Result recorded.');
    }

    async function signupButton(interaction, guild, action) {
        let outcome = null;
        const { record } = await store.mutate(guild.id, 'tournament', interaction.message.id, (tn) => {
            if (!tn) { outcome = 'gone'; return undefined; }
            if (tn.status !== 'signup') { outcome = 'closed'; return undefined; }
            const has = tn.players.includes(interaction.user.id);
            if (action === 'join') {
                if (has) { outcome = 'already'; return undefined; }
                if (tn.players.length >= tn.max) { outcome = 'full'; return undefined; }
                tn.players.push(interaction.user.id);
            } else {
                if (!has) { outcome = 'notin'; return undefined; }
                tn.players = tn.players.filter((id) => id !== interaction.user.id);
            }
            outcome = action;
            return tn;
        });
        const texts = { gone: '❌ This tournament is no longer tracked.', closed: 'Sign-ups are closed.', already: 'You are already signed up.', full: '❌ The tournament is full.', notin: 'You were not signed up.', join: '✅ You are signed up!', leave: 'You left the tournament.' };
        if (record && (outcome === 'join' || outcome === 'leave')) await interaction.message.edit?.({ content: bracketText(record.data), components: signupButtons(true), allowedMentions: NO_PINGS }).catch(() => {});
        return reply(interaction, texts[outcome]);
    }

    // -------------------------------------------------------------- dispatch
    async function run(interaction, fn) {
        try {
            const guild = interaction.guild;
            if (!guild) return reply(interaction, '❌ This only works inside a server.');
            const ctx = await ctxFor(guild);
            if (!ctx) return reply(interaction, '❌ ZiGBoT is switched off in this server by its admins.');
            return await fn(guild, ctx.e, ctx.settings);
        } catch (error) {
            fail(interaction.commandName || interaction.customId || 'interaction', error);
            return reply(interaction, '❌ Something went wrong. Nothing was changed.').catch(() => {});
        }
    }

    const COMMANDS = ['level', 'eco', 'games', 'giveaway', 'tournament'];
    return {
        COMMANDS,
        onMessage,
        endGiveaway,
        handlesSlash: (interaction) => COMMANDS.includes(interaction.commandName),
        handleSlash: (interaction) => run(interaction, (guild, e, settings) => {
            const handlers = { level, eco, games, giveaway, tournament };
            return handlers[interaction.commandName](interaction, guild, e, settings);
        }),
        isComponent: (interaction) => typeof interaction.customId === 'string' && interaction.customId.startsWith(PREFIX),
        handleComponent: (interaction) => run(interaction, (guild, e, settings) => {
            const [kind, a, b] = interaction.customId.slice(PREFIX.length).split(':');
            if (kind === 'tr') return tradeButton(interaction, guild, e, settings, a, b);
            if (kind === 'tv') return triviaButton(interaction, guild, e, a, b);
            if (kind === 'ga') return giveawayButton(interaction, guild);
            if (kind === 'to') return signupButton(interaction, guild, a);
            return reply(interaction, '❌ Unknown button.');
        })
    };
}

module.exports = { createEngagement };
