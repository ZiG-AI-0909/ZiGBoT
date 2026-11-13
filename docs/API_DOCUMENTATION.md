# Security API Documentation

## `classifyUrl(rawUrl)`

Returns a status of `safe`, `phishing`, or `unknown`.

## `scoreThreatAssessment(options)`

Returns a risk object with:

- `score`
- `label`
- `confidence`
- `evidence`

## `evaluateSecurityPolicy({ score, label, evidence, serverPolicy })`

Returns the action to take:

- `log_only`
- `monitor`
- `notify_moderators`
- `quarantine`
- `emergency_lockdown`

## `SecurityEventProcessor.processEvent(event)`

Processes message metadata into a scored, policy-driven security result.
