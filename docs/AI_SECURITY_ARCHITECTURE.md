# AI Security Architecture

## Architecture Summary

The project now includes a modular security layer under `src/security/` that separates:

- detection (`detectors/`)
- scoring (`scoring/`)
- policies (`policies/`)
- response planning (`response/`)
- incident management (`core/`)
- AI assistant summary (`intelligence/`)

This keeps deterministic rules ahead of model-based classification and ensures all actions are explainable and constrained.

## Runtime Flow

1. Incoming event or message is normalized.
2. Deterministic detectors inspect URLs, message content, behavior, and join patterns.
3. Threat scoring combines evidence and applies a small correlation penalty.
4. Policy evaluation decides whether to log, monitor, quarantine, or trigger emergency lockdown.
5. Response planning generates actions without allowing unrestricted AI administration.
6. Incident records are kept in memory and can be persisted in the project database layer later.

## Security Principles

- Treat Discord content as untrusted.
- Keep AI output advisory rather than authoritative.
- Use deterministic rules as the enforcement layer.
- Never permit unrestricted privilege changes from AI.
- Record evidence separately from risk score.
