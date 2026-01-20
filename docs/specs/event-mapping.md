# Event Mapping

This document describes how provider adapters should translate upstream SDK/CLI events into the unified `RuntimeEvent` stream.

If you’re consuming events (not implementing an adapter), start with the user-facing guide: `docs/guides/events.md`.

## Source of truth

Event types live in `packages/runtime-core/`.

Provider adapters that perform mapping:
- Codex: `packages/provider-codex/`
- Claude: `packages/provider-claude/`

## Goals

- **Consistency for orchestrators**: an orchestrator should not need provider-specific branching for basic lifecycle, assistant output, and tool calls/results.
- **Preserve provider detail**: adapters may emit `provider.event` for unmapped/raw upstream payloads.
- **Best-effort where required**: some providers do not stream all event types (for example, reasoning deltas); adapters should still provide the most useful unified events they can.

## Mapping guidelines

- Prefer emitting `assistant.delta` when the provider supports streaming text; otherwise emit `assistant.message` when the final assistant text is available.
- Emit `tool.call` / `tool.result` only when there is a clear call/result lifecycle; otherwise use `provider.event`.
- Preserve stable correlation IDs when available (`callId`, `runId`, provider item IDs) so consumers can match `tool.call` ↔ `tool.result`.
- Map usage into the unified `usage` event when the provider reports token accounting; omit fields that are not available.

## Ordering

Adapters should preserve the provider’s natural ordering as much as possible and ensure a predictable high-level sequence:

1. `run.started`
2. Zero or more `assistant.*` / `tool.*` / `provider.event` / `usage`
3. `run.completed`

## Provider differences

Provider capabilities differ (streaming granularity, available lifecycle hooks, and tool visibility). Adapters should expose these differences explicitly via `runtime.capabilities()` and still emit a coherent unified event stream.

