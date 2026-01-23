# Experiments

These pages contain **repeatable experiments** that validate how unified-agent-sdk behaves across providers.

They’re primarily for SDK/CLI users who want to understand **what’s portable** and where provider differences show up.

## What you’ll find here

| Experiment | What it validates | Why you might care |
|---|---|---|
| [2026-01-23: Permission E2E Testing](2026-01-23-permission-e2e-testing.md) | End-to-end behavior matrix across providers | Confidence that settings work “for real” |
| [2026-01-23: Access & Sandboxing](2026-01-23-access-sandboxing.md) | Consolidated into the permission e2e report (kept for backward links) | If you bookmarked the old URL |
| [2026-01-20: In-Flight Session Reconfiguration](2026-01-20-inflight-session-reconfiguration.md) | Which `SessionConfig` fields can be changed mid-session via snapshot/resume | Long-lived sessions without losing conversation history |

## Notes on “trust”

Experiments are a **point-in-time** snapshot. Providers, SDKs, and CLIs evolve quickly, so each experiment includes a test date and versions.

If you see drift, please open an issue or update the experiment with new results.

Naming convention:
- Experiments use date-prefixed filenames: `YYYY-MM-DD-{title}.md`.
- Legacy experiments include `legacy`: `YYYY-MM-DD-legacy-{title}.md`.
