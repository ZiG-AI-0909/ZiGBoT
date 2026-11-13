function clamp(value, min = 0, max = 100) {
  return Math.min(max, Math.max(min, value));
}

function classifyRisk(score) {
  if (score >= 80) return 'Critical';
  if (score >= 60) return 'Severe';
  if (score >= 40) return 'High Risk';
  if (score >= 20) return 'Suspicious';
  return 'Normal';
}

function scoreThreatAssessment({
  urlRisk = 0,
  behaviorRisk = 0,
  raidRisk = 0,
  scamRisk = 0,
  mentionRisk = 0,
  historicalRisk = 0,
  confidence = 0.5,
  correlationPenalty = 0,
  allowDecay = false,
  decayFactor = 1
} = {}) {
  const baseScore = (
    Number(urlRisk || 0) * 0.6 +
    Number(behaviorRisk || 0) * 0.25 +
    Number(raidRisk || 0) * 0.2 +
    Number(scamRisk || 0) * 0.35 +
    Number(mentionRisk || 0) * 0.2 +
    Number(historicalRisk || 0) * 0.3
  );

  const penalty = clamp(Number(correlationPenalty || 0), 0, 40);
  let score = baseScore - penalty;

  if (urlRisk >= 40 && scamRisk >= 20) score += 5;
  if (urlRisk >= 50 && scamRisk >= 30) score += 15;
  if (scamRisk >= 30 && mentionRisk >= 10) score += 10;
  if (scamRisk >= 35) score += 10;
  if (scamRisk >= 55) score += 15;

  if (allowDecay) {
    score *= decayFactor;
  }

  const finalScore = clamp(Math.round(score), 0, 100);
  const finalConfidence = clamp(Number(confidence || 0.5), 0, 1);

  const evidence = [
    urlRisk > 0 ? `URL reputation risk: ${urlRisk}` : null,
    behaviorRisk > 0 ? `Behavior anomalies: ${behaviorRisk}` : null,
    raidRisk > 0 ? `Raid indicators: ${raidRisk}` : null,
    scamRisk > 0 ? `Scam indicators: ${scamRisk}` : null,
    mentionRisk > 0 ? `Mention abuse: ${mentionRisk}` : null,
    historicalRisk > 0 ? `Historical security signals: ${historicalRisk}` : null
  ].filter(Boolean);

  return {
    score: finalScore,
    label: classifyRisk(finalScore),
    confidence: finalConfidence,
    evidence,
    decayApplied: allowDecay && decayFactor !== 1,
    normalized: true
  };
}

module.exports = { clamp, classifyRisk, scoreThreatAssessment };
