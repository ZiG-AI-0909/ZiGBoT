/**
 * Safe outbound HTTPS for user-supplied URLs (RSS feeds). SSRF protection:
 *  - https only, default port only, no credentials in the URL;
 *  - the address is checked AT CONNECT TIME through the socket's `lookup`,
 *    so a hostname that resolves to a private, loopback, link-local,
 *    metadata or other internal address is refused, including DNS
 *    rebinding (no separate "check, then fetch" race);
 *  - IP-literal hosts are checked the same way;
 *  - redirects are followed by hand (max 3), each one checked again;
 *  - 10 s timeout and a 1 MB body cap.
 */
const https = require('node:https');
const dns = require('node:dns');
const net = require('node:net');

const MAX_BYTES = 1024 * 1024;
const TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;

function ipv4Blocked(ip) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224
        || (a === 100 && b >= 64 && b <= 127) // carrier-grade NAT
        || (a === 169 && b === 254) // link-local, cloud metadata (169.254.169.254)
        || (a === 172 && b >= 16 && b <= 31)
        || (a === 192 && b === 168)
        || (a === 192 && b === 0)
        || (a === 198 && (b === 18 || b === 19));
}

/** true for any address an outside fetch must never reach. */
function isBlockedAddress(address) {
    if (net.isIPv4(address)) return ipv4Blocked(address);
    if (!net.isIPv6(address)) return true;
    const ip = address.toLowerCase();
    const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return ipv4Blocked(mapped[1]);
    return ip === '::' || ip === '::1' || /^f[cd]/.test(ip) || /^fe[89ab]/.test(ip) || /^ff/.test(ip) || ip.startsWith('64:ff9b:') || ip.startsWith('2001:db8:');
}

/** dns.lookup replacement that refuses blocked addresses (used by the socket itself). */
function guardedLookup(resolver = dns.lookup) {
    return (hostname, options, callback) => {
        resolver(hostname, { ...options, all: true }, (error, addresses) => {
            if (error) return callback(error);
            const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: options?.family || 4 }];
            const bad = list.find((a) => isBlockedAddress(a.address));
            if (!list.length || bad) {
                const refused = new Error(`Refused to connect to an internal address (${hostname}).`);
                refused.code = 'EBLOCKED';
                return callback(refused);
            }
            if (options?.all) return callback(null, list);
            return callback(null, list[0].address, list[0].family);
        });
    };
}

/** Parses and checks a URL before any connection; throws on anything unsafe. */
function checkUrl(raw) {
    let url;
    try {
        url = new URL(String(raw));
    } catch {
        throw new Error('Not a valid URL.');
    }
    if (url.protocol !== 'https:') throw new Error('Only https:// links are allowed.');
    if (url.username || url.password) throw new Error('Links with credentials are not allowed.');
    if (url.port && url.port !== '443') throw new Error('Only the standard https port is allowed.');
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(host) && isBlockedAddress(host)) throw new Error('Internal addresses are not allowed.');
    if (/^(localhost|.*\.local|.*\.internal|.*\.localhost)$/i.test(host)) throw new Error('Internal hostnames are not allowed.');
    return url;
}

function requestOnce(url, { resolver, headers }) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, {
            lookup: guardedLookup(resolver),
            headers: { 'User-Agent': 'ZiGBoT feed reader (+https://www.zigbot.in)', Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, application/json;q=0.8', ...headers },
            timeout: TIMEOUT_MS
        }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume();
                return resolve({ redirect: new URL(res.headers.location, url).toString() });
            }
            if (res.statusCode !== 200) {
                res.resume();
                return reject(new Error(`HTTP ${res.statusCode}`));
            }
            const chunks = [];
            let size = 0;
            res.on('data', (chunk) => {
                size += chunk.length;
                if (size > MAX_BYTES) {
                    req.destroy(new Error('Response too large.'));
                    return;
                }
                chunks.push(chunk);
            });
            res.on('end', () => resolve({ body: Buffer.concat(chunks).toString('utf8') }));
            res.on('error', reject);
        });
        req.on('timeout', () => req.destroy(new Error('Timed out.')));
        req.on('error', reject);
    });
}

/** GET a user-supplied https URL safely; resolves to the body text. */
async function safeFetchText(raw, { resolver = dns.lookup, headers = {}, request = requestOnce } = {}) {
    let target = checkUrl(raw).toString();
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
        const result = await request(new URL(target), { resolver, headers });
        if (result.redirect === undefined) return result.body;
        target = checkUrl(result.redirect).toString(); // every hop is checked again
    }
    throw new Error('Too many redirects.');
}

module.exports = { safeFetchText, checkUrl, isBlockedAddress, guardedLookup, MAX_BYTES };
