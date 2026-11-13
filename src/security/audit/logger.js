const { auditLog: defaultAuditLog } = require('../../logging/auditLog');

const REDACTED = '[REDACTED]';
const SENSITIVE_KEY = /(?:token|secret|password|api[_-]?key|authorization|cookie)/i;
const SECRET_PATTERNS = [
  { pattern: /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, replacement: 'Bearer [REDACTED]' },
  { pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g, replacement: REDACTED },
  { pattern: /\b[A-Za-z0-9_-]{24}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{20,}\b/g, replacement: REDACTED }
];

function redactText(value) {
  return SECRET_PATTERNS.reduce((text, item) => text.replace(item.pattern, item.replacement), value);
}

function redactSensitive(value, seen = new WeakSet()) {
  if (typeof value === 'string') return redactText(value);
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  if (Array.isArray(value)) return value.map((item) => redactSensitive(item, seen));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    SENSITIVE_KEY.test(key) ? REDACTED : redactSensitive(item, seen)
  ]));
}

async function auditSecurityEvent(entry = {}, { auditLog = defaultAuditLog } = {}) {
  const sourceMessage = entry.message || {};
  const sourceGuild = sourceMessage.guild || entry.guild || null;
  const guildId = sourceGuild?.id || entry.guildId || null;
  const userId = sourceMessage.author?.id || entry.userId || entry.actorId || 'security-system';
  const safeDetails = redactSensitive(entry.details || {});

  return auditLog({
    message: {
      author: { id: redactText(String(userId)) },
      guild: guildId ? { id: redactText(String(guildId)) } : null,
      ...(sourceMessage.client ? { client: sourceMessage.client } : {})
    },
    settings: { logChannelId: entry.settings?.logChannelId },
    event: redactText(String(entry.event || 'SECURITY')),
    action: redactText(String(entry.action || 'security_event')),
    target: redactText(String(entry.target || 'none')),
    result: redactText(String(entry.result || 'logged')),
    details: safeDetails
  });
}

module.exports = { auditSecurityEvent, redactSensitive };
