function detectRaidSignals({
  joinRate = 0,
  mentionBurst = 0,
  repeatedMessagePattern = 0,
  invitationPattern = 0,
  accountAgeVariance = 0
} = {}) {
  let score = 0;
  const evidence = [];

  if (joinRate >= 8) {
    score += 25;
    evidence.push('High join rate');
  }
  if (mentionBurst >= 10) {
    score += 18;
    evidence.push('Mass mention burst');
  }
  if (repeatedMessagePattern >= 3) {
    score += 18;
    evidence.push('Repeated message campaign');
  }
  if (invitationPattern >= 1) {
    score += 15;
    evidence.push('Suspicious invite pattern');
  }
  if (accountAgeVariance >= 1) {
    score += 10;
    evidence.push('Coordinated new-account cluster');
  }

  return {
    type: score >= 30 ? 'raid-risk' : 'normal',
    score: Math.min(100, score),
    evidence
  };
}

module.exports = { detectRaidSignals };
