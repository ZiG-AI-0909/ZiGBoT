function evaluateSecurityPolicy({ score = 0, label = 'Normal', evidence = [], serverPolicy = {} } = {}) {
  const config = {
    quarantineEnabled: true,
    moderatorNotifyThreshold: 40,
    emergencyLockdownThreshold: 80,
    ...serverPolicy
  };

  if (score >= config.emergencyLockdownThreshold || label === 'Critical') {
    return {
      action: 'emergency_lockdown',
      severity: 'critical',
      requiresModeratorReview: true,
      quarantine: true,
      notifyOwner: true,
      reason: 'Critical risk exceeds configured emergency threshold.'
    };
  }

  if (score >= 60 || label === 'Severe') {
    return {
      action: 'quarantine',
      severity: 'severe',
      requiresModeratorReview: true,
      quarantine: config.quarantineEnabled,
      notifyOwner: false,
      reason: 'Severe threat requires temporary restrictions.'
    };
  }

  if (score >= config.moderatorNotifyThreshold || label === 'High Risk') {
    return {
      action: 'notify_moderators',
      severity: 'high',
      requiresModeratorReview: false,
      quarantine: false,
      notifyOwner: false,
      reason: 'High risk should be reviewed by moderators.'
    };
  }

  if (score >= 20) {
    return {
      action: 'monitor',
      severity: 'suspicious',
      requiresModeratorReview: false,
      quarantine: false,
      notifyOwner: false,
      reason: 'Suspicious activity requires monitoring.'
    };
  }

  return {
    action: 'log_only',
    severity: 'normal',
    requiresModeratorReview: false,
    quarantine: false,
    notifyOwner: false,
    reason: `No action beyond logging for ${evidence.length || 0} evidence points.`
  };
}

module.exports = { evaluateSecurityPolicy };
