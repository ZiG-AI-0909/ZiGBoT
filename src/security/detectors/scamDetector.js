const SHORTENERS = new Set([
  'bit.ly', 'tinyurl.com', 'goo.gl', 't.co', 'is.gd', 'ow.ly', 'buff.ly', 't.ly', 'rebrand.ly'
]);

const SUSPICIOUS_PATTERNS = [
  'free nitro', 'discord nitro', 'giveaway', 'claim your prize', 'verify now', 'click here',
  'steam wallet', 'roblox free', 'crypto giveaway', 'double your', 'urgent reward',
  'dm me', 'cash out', 'instant payout', 'limited time'
];

const PROMPT_INJECTION_PATTERNS = [
  'ignore previous instructions',
  'ignore all previous instructions',
  'override system prompt',
  'you are now',
  'act as admin',
  'ban everyone'
];

const CONFUSABLE_MAP = {
  а: 'a', е: 'e', і: 'i', о: 'o', р: 'p', с: 'c', х: 'x', к: 'k', у: 'y', м: 'm', 
  Α: 'A', Β: 'B', Ε: 'E', Η: 'H', Ι: 'I', Κ: 'K', Μ: 'M', Ν: 'N', Ο: 'O', Ρ: 'P', 
  Τ: 'T', Χ: 'X', Υ: 'Y', α: 'a', ε: 'e', ι: 'i', ο: 'o', ρ: 'p', χ: 'x', κ: 'k', μ: 'm', ν: 'n'
};

function normalizeHostnameForComparison(hostname = '') {
  return String(hostname || '')
    .toLowerCase()
    .normalize('NFKC')
    .split('.')
    .map((part) => Array.from(part).map((char) => CONFUSABLE_MAP[char] || char).join(''))
    .join('.');
}

function normalizeUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;
  try {
    return new URL(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
}

function classifyUrl(rawUrl) {
  const url = normalizeUrl(rawUrl);
  if (!url) return { status: 'unknown', target: rawUrl || null, reason: 'Invalid URL input' };

  const hostname = url.hostname.toLowerCase();
  const normalizedHostname = normalizeHostnameForComparison(hostname);
  const path = `${url.pathname} ${url.search}`.toLowerCase();
  const hostBits = hostname.split('.');
  const normalizedBits = normalizedHostname.split('.');
  const shortened = SHORTENERS.has(hostname) || SHORTENERS.has(normalizedHostname) || hostBits.some((part) => SHORTENERS.has(part)) || normalizedBits.some((part) => SHORTENERS.has(part));
  const suspiciousPath = SUSPICIOUS_PATTERNS.some((pattern) => path.includes(pattern)) || PROMPT_INJECTION_PATTERNS.some((pattern) => path.includes(pattern));
  const phishingKeywords = ['discord', 'nitro', 'gift', 'login', 'verify', 'claim', 'wallet', 'crypto', 'reward', 'prize']
    .filter((keyword) => path.includes(keyword) || normalizedHostname.includes(keyword));
  const suspiciousDomain = normalizedBits.some((part) => part.includes('gift') || part.includes('claim') || part.includes('verify') || part.includes('discord'));
  const rawHostText = String(rawUrl).normalize('NFKC').toLowerCase();
  const rawHostOnly = rawHostText.replace(/^https?:\/\//, '').split(/[/?#]/)[0];
  const homoglyphHost = rawHostOnly && /[^\x00-\x7F]/.test(rawHostOnly) && (
    normalizeHostnameForComparison(rawHostOnly).includes('discord') ||
    normalizeHostnameForComparison(rawHostOnly).includes('nitro') ||
    normalizeHostnameForComparison(rawHostOnly).includes('gift') ||
    normalizeHostnameForComparison(rawHostOnly).includes('claim') ||
    normalizeHostnameForComparison(rawHostOnly).includes('verify')
  );

  const isHomoglyph = homoglyphHost || (hostname !== normalizedHostname && /[^\x00-\x7F]/.test(hostname));

  const isPhishing = shortened || suspiciousPath || suspiciousDomain || isHomoglyph;
  if (isPhishing) {
    return {
      status: 'phishing',
      target: hostname,
      reason: `Suspect URL metadata: ${phishingKeywords.length ? phishingKeywords.join(', ') : 'scam indicators'}`
    };
  }

  return { status: 'safe', target: hostname, reason: 'No high-confidence scam indicators found' };
}

function detectScamSignals({ content = '', urls = [] } = {}) {
  const text = String(content || '').toLowerCase();
  const hits = [];
  for (const pattern of SUSPICIOUS_PATTERNS) {
    if (text.includes(pattern)) hits.push(pattern);
  }
  for (const pattern of PROMPT_INJECTION_PATTERNS) {
    if (text.includes(pattern)) hits.push(pattern);
  }

  const urlResults = Array.isArray(urls) ? urls.map(classifyUrl).filter((result) => result.status === 'phishing') : [];
  const suspiciousUrls = urlResults.map((result) => result.target);

  const promptHitCount = hits.filter((hit) => PROMPT_INJECTION_PATTERNS.some((pattern) => pattern === hit)).length;
  const score = Math.min(60, hits.length * 8 + suspiciousUrls.length * 25 + promptHitCount * 10 + (text.includes('urgent') ? 10 : 0));
  return {
    type: score >= 25 ? 'scam' : 'benign',
    score,
    hits: [...new Set(hits)],
    suspiciousUrls,
    evidence: [
      ...hits.map((hit) => `Message contains suspicious phrase: ${hit}`),
      ...urlResults.map((result) => `URL flagged as phishing: ${result.target}`)
    ]
  };
}

module.exports = { classifyUrl, detectScamSignals, SHORTENERS, SUSPICIOUS_PATTERNS, PROMPT_INJECTION_PATTERNS };
