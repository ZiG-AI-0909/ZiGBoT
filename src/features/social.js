/**
 * Section I, social notifications (docs/ZIGBOT_FEATURE_MATRIX.md). Off
 * until a server switches it on (feature_settings.social).
 *
 *   RSS / Atom feeds       any public https feed (SSRF-safe fetch, src/features/net.js)
 *   Reddit                 the subreddit's public RSS feed
 *   YouTube uploads        the channel's public RSS feed (no API quota; the
 *                          existing live-chat module is not touched)
 *   Twitch "went live"     official Helix API (TWITCH_CLIENT_ID / _SECRET)
 *
 * Polled on the shared scheduler, at most every `poll_minutes` (>= 5) per
 * server. The first poll of a feed only remembers what is there (no flood
 * of old posts); after that up to 3 new items per feed per poll are posted.
 * Kick, X and Instagram are not supported: no official free API.
 */
const crypto = require('node:crypto');
const { safeFetchText } = require('./net');
const { NO_PINGS, sectionOf, safeText } = require('./common');

const MIN_POLL_MS = 5 * 60_000;
const MAX_NEW_PER_POLL = 3;
const SEEN_KEEP = 60;

const decode = (s) => String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, '&')
    .trim();
const tag = (block, name) => {
    const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
    return m ? decode(m[1]) : '';
};

/** RSS 2.0 <item> and Atom <entry> → [{ id, title, link }], newest first as in the feed. */
function parseFeed(xml) {
    const text = String(xml || '');
    const blocks = [...text.matchAll(/<(item|entry)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi)].map((m) => m[2]).slice(0, 50);
    return blocks.map((b) => {
        const atomLink = b.match(/<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i) || b.match(/<link[^>]*href=["']([^"']+)["']/i);
        const link = tag(b, 'link') || (atomLink ? decode(atomLink[1]) : '');
        const id = tag(b, 'guid') || tag(b, 'id') || tag(b, 'yt:videoId') || link || tag(b, 'title');
        return { id: id.slice(0, 300), title: tag(b, 'title').slice(0, 250), link: /^https:\/\//i.test(link) ? link : '' };
    }).filter((e) => e.id);
}

/** The URL to poll for one configured feed. */
function feedUrl(feed) {
    if (feed.type === 'reddit') return `https://www.reddit.com/r/${encodeURIComponent(feed.source)}/new/.rss`;
    if (feed.type === 'youtube') return `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(feed.source)}`;
    return feed.source;
}

const feedKey = (prefix, value) => `${prefix}:${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24)}`;

/** Twitch Helix with an app access token (client credentials). */
function createTwitchApi({ clientId, clientSecret, fetchImpl = globalThis.fetch, now = () => Date.now() }) {
    let token = null;
    let expiresAt = 0;
    async function auth() {
        if (token && now() < expiresAt - 60_000) return token;
        const res = await fetchImpl('https://id.twitch.tv/oauth2/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: 'client_credentials' }),
            signal: AbortSignal.timeout(10_000)
        });
        if (!res.ok) throw new Error(`Twitch auth failed (${res.status})`);
        const data = await res.json();
        token = data.access_token;
        expiresAt = now() + Number(data.expires_in || 3600) * 1000;
        return token;
    }
    return {
        enabled: Boolean(clientId && clientSecret),
        /** Live streams for up to 100 logins: [{ user_login, user_name, title, game_name, id }]. */
        async liveStreams(logins) {
            if (!logins.length) return [];
            const query = new URLSearchParams();
            for (const login of logins.slice(0, 100)) query.append('user_login', login);
            const res = await fetchImpl(`https://api.twitch.tv/helix/streams?${query}`, {
                headers: { 'Client-Id': clientId, Authorization: `Bearer ${await auth()}` },
                signal: AbortSignal.timeout(10_000)
            });
            if (res.status === 401) token = null;
            if (!res.ok) throw new Error(`Twitch streams failed (${res.status})`);
            return (await res.json()).data || [];
        }
    };
}

function createSocial({ store, scheduler, resolveContext, getClient = () => null, fetchText = safeFetchText, twitch = null, now = () => Date.now(), logger = console }) {
    const fail = (what, error) => logger.error?.(`[ZiGBoT SOCIAL] ${what} failed: ${error?.code || error?.message || error}`);

    async function post(guild, channelId, content, roleId = null) {
        const channel = guild.channels?.cache?.get?.(channelId);
        if (!channel?.isTextBased?.()) return false;
        await channel.send({ content: content.slice(0, 1900), allowedMentions: roleId ? { parse: [], roles: [roleId] } : NO_PINGS }).catch((error) => fail('post', error));
        return true;
    }

    /** Remembers ids, returns the ones not seen before (none on the very first poll). */
    async function newItems(guildId, key, ids) {
        let fresh = [];
        await store.mutate(guildId, 'feed_seen', key, (d) => {
            if (!d) { fresh = []; return { ids: ids.slice(0, SEEN_KEEP) }; }
            const seen = new Set(d.ids);
            fresh = ids.filter((id) => !seen.has(id));
            if (!fresh.length) return undefined;
            return { ids: [...fresh, ...d.ids].slice(0, SEEN_KEEP) };
        }, { attempts: 20 });
        return fresh;
    }

    async function pollFeeds(guild, s) {
        for (const feed of s.feeds) {
            try {
                const items = parseFeed(await fetchText(feedUrl(feed)));
                const fresh = await newItems(guild.id, feedKey('feed', [feed.type, feed.source]), items.map((i) => i.id));
                const label = feed.type === 'youtube' ? '📺 New video' : feed.type === 'reddit' ? `🟠 New on r/${safeText(feed.source, 30)}` : '📰 New post';
                for (const item of items.filter((i) => fresh.includes(i.id)).slice(0, MAX_NEW_PER_POLL).reverse()) {
                    await post(guild, feed.channel_id, `${label}: **${safeText(item.title || 'Untitled', 250)}**${item.link ? `\n${item.link}` : ''}`);
                }
            } catch (error) {
                fail(`${feed.type} feed`, error);
            }
        }
    }

    async function pollTwitch(guild, s) {
        if (!twitch?.enabled || !s.twitch.length) return;
        const streams = await twitch.liveStreams(s.twitch.map((t) => t.login.toLowerCase()));
        const live = new Map(streams.map((st) => [String(st.user_login).toLowerCase(), st]));
        for (const entry of s.twitch) {
            const stream = live.get(entry.login.toLowerCase());
            const key = feedKey('twitch', entry.login.toLowerCase());
            // One notice per stream: remember the stream id; going offline resets it.
            let notify = false;
            await store.mutate(guild.id, 'feed_seen', key, (d) => {
                const current = stream ? String(stream.id) : null;
                // First check (no record yet) always stores the state, so the next live start alerts.
                if (d && (d.ids[0] ?? null) === current) return undefined;
                notify = Boolean(current && d); // not on the very first check
                return { ids: current ? [current] : [] };
            }, { attempts: 20 });
            if (notify) {
                const ping = entry.role_id ? `<@&${entry.role_id}> ` : '';
                await post(guild, entry.channel_id, `${ping}🟣 **${safeText(stream.user_name || entry.login, 60)}** is live on Twitch: ${safeText(stream.title, 200)}${stream.game_name ? ` (${safeText(stream.game_name, 60)})` : ''}\nhttps://twitch.tv/${encodeURIComponent(entry.login.toLowerCase())}`, entry.role_id);
            }
        }
    }

    async function tick(t) {
        for (const guild of getClient()?.guilds?.cache?.values?.() || []) {
            try {
                const context = await resolveContext(guild);
                if (context?.config?.enabled === false) continue;
                const s = sectionOf(context?.config, 'social');
                if (!(s.feeds_enabled && s.feeds.length) && !(s.twitch_enabled && s.twitch.length)) continue;
                // Claim this server's poll for the interval (also across restarts and workers).
                let due = false;
                await store.mutate(guild.id, 'feed_poll', 'last', (d) => {
                    if (d && t - d.at < Math.max(MIN_POLL_MS, s.poll_minutes * 60_000)) return undefined;
                    due = true;
                    return { at: t };
                });
                if (!due) continue;
                if (s.feeds_enabled) await pollFeeds(guild, s);
                if (s.twitch_enabled) await pollTwitch(guild, s).catch((error) => fail('twitch', error));
            } catch (error) {
                fail('poll', error);
            }
        }
    }
    scheduler.every(tick);

    return { tick };
}

module.exports = { createSocial, createTwitchApi, parseFeed, feedUrl, MIN_POLL_MS };
