const { SecurityEventProcessor, createSecurityEventProcessor } = require('./core/processor');
const { classifyUrl, detectScamSignals } = require('./detectors/scamDetector');
const { analyzeBehavior } = require('./detectors/behaviorDetector');
const { detectRaidSignals } = require('./detectors/raidDetector');
const { scoreThreatAssessment, classifyRisk } = require('./scoring/threatScoring');
const { evaluateSecurityPolicy } = require('./policies/policyEngine');
const { buildResponsePlan } = require('./response/responseEngine');
const { AiSecurityAssistant } = require('./intelligence/assistant');
const { IncidentManager } = require('./core/incidentManager');
const { createSecurityIntegration } = require('./integration');
const { createSecurityEventHandlers } = require('./eventHandlers');
const { createSecurityCommands } = require('./commands');

module.exports = {
  SecurityEventProcessor,
  createSecurityEventProcessor,
  classifyUrl,
  detectScamSignals,
  analyzeBehavior,
  detectRaidSignals,
  scoreThreatAssessment,
  classifyRisk,
  evaluateSecurityPolicy,
  buildResponsePlan,
  AiSecurityAssistant,
  IncidentManager,
  createSecurityIntegration,
  createSecurityEventHandlers,
  createSecurityCommands
};
