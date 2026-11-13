# Threat Model

## Threat Classes

- Scam and phishing messages
- Mass mentions and coordinated spam
- Suspicious join bursts and raid behavior
- Dangerous permission changes and destructive event bursts
- New-account risk combined with suspicious content

## Risk Classification

- 0-19: Normal
- 20-39: Suspicious
- 40-59: High Risk
- 60-79: Severe
- 80-100: Critical

## Design Notes

- Evidence is scored with a weighted model but correlation penalties prevent double counting.
- Confidence is tracked separately from score.
- Risk scores are not proof of wrongdoing; they are decision support for review.
- Response decisions require moderation review or owner alert based on threshold configuration.
