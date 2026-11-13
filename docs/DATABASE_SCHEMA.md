# Database Schema

## Recommended Security Tables

- `security_events` — message and audit event records
- `threat_assessments` — score, label, confidence, created_at
- `threat_evidence` — attack-related evidence pieces and metadata
- `security_incidents` — high-risk and critical events
- `suspicious_users` — tracked user IDs and last seen risk metrics
- `security_policies` — per-server thresholds and actions
- `trusted_administrators` — allowlisted admin IDs
- `quarantine_records` — restricted message/user records
- `security_actions` — executed moderator actions and audit trails
- `security_configurations` — per-server configuration state
- `ai_analysis_logs` — model and deterministic evaluation logs

## Requirements

- Use per-server scoping and row-level access controls.
- Keep sensitive content minimal and redact payloads when not necessary.
- Enforce retention windows.
- Validate every row before storing.
