# Experiments

These pages contain **repeatable experiments** that validate how unified-agent-sdk behaves across providers.

They’re primarily for SDK/CLI users who want to understand **what’s portable** and where provider differences show up.

## What you’ll find here

| Experiment | What it validates | Why you might care |
|---|---|---|
| [Access & Sandboxing](access.md) | How `SessionConfig.access` maps to provider sandboxing/tools | Predictability + safety when you run agents on real machines |
| [In-Flight Reconfiguration](inflight-reconfiguration.md) | Which `SessionConfig` fields can be changed mid-session via snapshot/resume | Long-lived sessions without losing conversation history |

## Notes on “trust”

Experiments are a **point-in-time** snapshot. Providers, SDKs, and CLIs evolve quickly, so each experiment includes a test date and versions.

If you see drift, please open an issue or update the experiment with new results.

