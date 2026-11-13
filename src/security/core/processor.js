const { classifyUrl, detectScamSignals } = require('../detectors/scamDetector');
const { analyzeBehavior } = require('../detectors/behaviorDetector');
const { detectRaidSignals } = require('../detectors/raidDetector');
const { scoreThreatAssessment } = require('../scoring/threatScoring');
const { evaluateSecurityPolicy } = require('../policies/policyEngine');
const { buildResponsePlan } = require('../response/responseEngine');
const { IncidentManager } = require('./incidentManager');

class SecurityEventProcessor {
  constructor({ incidentManager = null, serverPolicy = {} } = {}) {
    this.incidentManager = incidentManager || new IncidentManager();
    this.serverPolicy = serverPolicy;
  }

  processEvent(event = {}) {
    const content = String(event.message || '');
    const urlRisk = this._aggregateUrlRisk(event.urls || [], content);
    const scamSignals = detectScamSignals({ content, urls: event.urls || [] });
    const behaviorSignals = analyzeBehavior({
      messageCount: event.messageCount || 0,
      mentionCount: event.mentionCount || 0,
      repeatedMessages: event.repeatedMessages || 0,
      moderationEvasion: event.moderationEvasion || 0,
      accountAgeMs: event.accountAgeMs || 0,
      suspiciousDmActivity: event.suspiciousDmActivity || 0,
      userId: event.userId
    });
    const raidSignals = detectRaidSignals({
      joinRate: event.joinRate || 0,
      mentionBurst: event.mentionCount || 0,
      repeatedMessagePattern: event.repeatedMessages || 0,
      invitationPattern: event.invitationPattern || 0,
      accountAgeVariance: event.accountAgeVariance || 0
    });

    const assessment = scoreThreatAssessment({
      urlRisk,
      behaviorRisk: behaviorSignals.score,
      raidRisk: raidSignals.score,
      scamRisk: scamSignals.score,
      mentionRisk: (event.mentionCount || 0) * 4,
      historicalRisk: event.historicalRisk || 0,
      confidence: event.confidence || 0.8,
      correlationPenalty: this._dedupePenalty({
        scamSignals,
        behaviorSignals,
        raidSignals
      })
    });

    const evidence = [...new Set([
      ...(assessment.evidence || []),
      ...(scamSignals.evidence || []),
      ...(behaviorSignals.evidence || []),
      ...(raidSignals.evidence || [])
    ])];
    assessment.evidence = evidence;

    const policyDecision = evaluateSecurityPolicy({
      score: assessment.score,
      label: assessment.label,
      evidence: assessment.evidence,
      serverPolicy: this.serverPolicy
    });

    const response = buildResponsePlan({
      score: assessment.score,
      label: assessment.label,
      policyDecision,
      serverPolicy: this.serverPolicy
    });

    const incident = this.incidentManager.createIncident({
      guildId: event.guildId,
      userId: event.userId,
      score: assessment.score,
      label: assessment.label,
      evidence: assessment.evidence,
      policyDecision,
      eventId: event.eventId || event.id || `${event.guildId || 'unknown'}:${event.userId || 'unknown'}:${Date.now()}`
    });

    return {
      eventId: incident?.eventId || event.eventId || event.id || `${event.guildId || 'unknown'}:${event.userId || 'unknown'}`,
      guildId: event.guildId,
      userId: event.userId,
      score: assessment.score,
      label: assessment.label,
      confidence: assessment.confidence,
      evidence: assessment.evidence,
      scamSignals,
      behaviorSignals,
      raidSignals,
      policyDecision,
      response,
      incident
    };
  }

  _aggregateUrlRisk(urls = [], content = '') {
    const collected = Array.isArray(urls) ? urls : [];
    const safe = collected
      .map((value) => classifyUrl(value))
      .filter((result) => result.status === 'phishing');
    const contentRisk = /(?:free\s+nitro|giveaway|claim now|verify now|steam|roblox|crypto)/i.test(content) ? 15 : 0;
    return Math.min(100, safe.length * 35 + contentRisk);
  }

  _dedupePenalty({ scamSignals, behaviorSignals, raidSignals }) {
    const correlated = [
      scamSignals?.score || 0,
      behaviorSignals?.score || 0,
      raidSignals?.score || 0
    ].filter((v) => v > 0);
    if (!correlated.length) return 0;
    return Math.min(25, Math.round(correlated.reduce((a, b) => a + b, 0) * 0.08));
  }
}

function createSecurityEventProcessor(options = {}) {
  return new SecurityEventProcessor(options);
}

module.exports = { SecurityEventProcessor, createSecurityEventProcessor };
