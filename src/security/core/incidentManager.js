class IncidentManager {
  constructor() {
    this.incidents = [];
    this.seenEventIds = new Set();
  }

  createIncident({ guildId, userId, score, label, evidence = [], policyDecision = null, eventId = null }) {
    if (eventId && this.seenEventIds.has(eventId)) {
      return this.incidents.find((incident) => incident.eventId === eventId) || null;
    }

    const incident = {
      id: `inc-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      eventId: eventId || `event-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      guildId,
      userId,
      score,
      label,
      evidence,
      policyDecision,
      createdAt: new Date().toISOString()
    };
    this.incidents.push(incident);
    if (eventId) this.seenEventIds.add(eventId);
    return incident;
  }

  listIncidents(guildId = null) {
    if (!guildId) return [...this.incidents];
    return this.incidents.filter((incident) => incident.guildId === guildId);
  }

  getGuildIncidents(guildId) {
    return this.listIncidents(guildId);
  }
}

module.exports = { IncidentManager };
