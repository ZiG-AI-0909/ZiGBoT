function analyzeBehavior({
  messageCount = 0,
  mentionCount = 0,
  repeatedMessages = 0,
  moderationEvasion = 0,
  accountAgeMs = 0,
  suspiciousDmActivity = 0,
  userId = null
} = {}) {
  let score = 0;
  const evidence = [];

  if (messageCount >= 12) {
    score += 12;
    evidence.push('High message frequency');
  }
  if (mentionCount >= 6) {
    score += 15;
    evidence.push('Mention abuse');
  }
  if (repeatedMessages >= 3) {
    score += 18;
    evidence.push('Repeated message pattern');
  }
  if (moderationEvasion >= 1) {
    score += 20;
    evidence.push('Moderation evasion indicators');
  }
  if (suspiciousDmActivity >= 1) {
    score += 10;
    evidence.push('Suspicious DM activity');
  }
  if (accountAgeMs > 0 && accountAgeMs < 1000 * 60 * 60 * 24 * 7) {
    score += 12;
    evidence.push('New account age');
  }

  return {
    userId,
    type: score >= 30 ? 'suspicious' : 'normal',
    score: Math.min(100, score),
    evidence,
    risk: score >= 30 ? 'behavioural-risk' : 'baseline'
  };
}

module.exports = { analyzeBehavior };
