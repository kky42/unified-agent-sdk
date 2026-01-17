# ACP (Agent Client Protocol) and unified-agent-sdk

This document evaluates whether ACP can (and should) be reused in this repo to help orchestrators talk to multiple agents through a single interface.

## What ACP is (relevant framing)

ACP standardizes **Client ↔ Agent** communication (LSP-like), where the “Client” is typically an editor/IDE and the “Agent” is an autonomous coding agent.

Key points from the spec:
- JSON-RPC 2.0 message model.
- Common local transport is **stdio** with newline-delimited JSON (messages must not contain embedded newlines).
- Remote transports exist as a direction, but full remote support is explicitly described as work-in-progress.

In unified-agent-sdk terms: ACP is not a “model/provider SDK abstraction”. It is a **protocol for driving an agent process** that already exists (or is wrapped by an adapter) and can already operate on a workspace.

## 1) Is it possible to reuse ACP implementations in this project?

Yes.

ACP has official open-source implementations and a published schema:
- `@agentclientprotocol/sdk` (TypeScript SDK) — Apache-2.0, includes a `ClientSideConnection` and helpers like `ndJsonStream`.
- `@agentclientprotocol/schema` (schema repo) — Apache-2.0, includes `schema/schema.json` (stable) and `schema/schema.unstable.json` (draft/unstable methods).

So we can reuse ACP code in a new provider adapter package (e.g. `packages/provider-acp`) to allow orchestrators to “plug in” any ACP-speaking agent.

Important scope note: this reuse is best as an **optional provider backend** (an ACP-backed `UnifiedSession`), not as a replacement for `@unified-agent-sdk/runtime-core`.

## 2) Pros / Cons / Risks for unified-agent-sdk

### Pros

- **Ecosystem reach**: any ACP-compatible agent (or ACP adapter like `codex-acp`, `claude-code-acp`) becomes usable by orchestrators via one integration point.
- **Out-of-process isolation**: ACP is naturally process-/transport-boundary friendly (spawn locally over stdio; evolve to remote later).
- **Good “agent UX” primitives**: ACP has first-class concepts for tool calls, diffs, plans, session modes, and slash commands; this can enrich `RuntimeEvent` streams.
- **Licensing**: official ACP schema + SDK are Apache-2.0 (compatible as dependencies in this MIT-licensed repo).

### Cons

- **Editor-centric surface area**: ACP assumes the Client provides “host services” such as filesystem access and terminals. An orchestrator using ACP must implement those client methods (or disable them and accept reduced agent functionality).
- **Less provider-native control**: ACP (stable v1) does not standardize things orchestrators often want: model selection, token usage/cost reporting, structured output schemas, etc.
- **Potential double abstraction**: for Codex/Claude specifically, direct SDK adapters (`provider-codex`, `provider-claude`) will likely stay more capable/configurable than going through an ACP adapter.
- **Output is notification-driven**: `session/prompt` returns only a stop reason; the “assistant message” must be reconstructed from streamed `session/update` chunks.

### Risks

- **Spec evolution / instability**: the schema explicitly has an “unstable” track (`schema.unstable.json`) that includes additional methods like session resume/list/fork and model/config setting. Implementations may vary in what they support.
- **Remote transport maturity**: “streamable HTTP” is described as draft; interoperability may vary until this stabilizes.
- **Security/permissions**: enabling `terminal/*` and `fs/*` client methods grants significant power. An orchestrator must enforce workspace boundaries and implement a clear permission policy for `session/request_permission`.
- **Compatibility variance**: different agents may interpret `ToolKind`, permission options, and session update patterns differently; mapping into a single `RuntimeEvent` model will be best-effort for some fields.

## 3) If yes, how (recommended approach)

### A. Add an ACP-backed provider adapter (recommended)

Create `packages/provider-acp/` implementing:
- `UnifiedAgentRuntime` (connect/spawn agent; create sessions)
- `UnifiedSession` (send prompts; stream events; cancel; snapshot)

Implementation sketch using the official TypeScript SDK:
- Spawn/connect to an ACP agent (stdio is the baseline).
- Use `@agentclientprotocol/sdk`:
  - `ndJsonStream()` over stdin/stdout
  - `ClientSideConnection` to call `initialize`, `newSession`, `loadSession`, `prompt`, `cancel`, `setMode`
- Implement ACP “client” methods (the callbacks invoked by the agent):
  - `sessionUpdate` → map to `RuntimeEvent` (`assistant.delta`, `tool.*`, `provider.event`, etc.)
  - `requestPermission` → map to a provider-specific policy/callback
  - `readTextFile` / `writeTextFile` → implement using `SessionConfig.workspace` boundaries and `SessionConfig.access.auto`
  - `terminal/*` → implement using `child_process` with `SessionConfig.access` gating

Recommended mapping into `@unified-agent-sdk/runtime-core`:
- Emit `run.started` when `session/prompt` begins.
- Map `session/update.agent_message_chunk` (text) → `assistant.delta`.
- Map `session/update.agent_thought_chunk` (text) → `assistant.reasoning.delta` (best-effort; may be absent depending on agent).
- Map `session/update.tool_call` and `tool_call_update` → `tool.call` / `tool.result` when possible, otherwise `provider.event` to avoid lossy mappings.
- Emit `assistant.message` at the end (accumulated text), then `run.completed` when the `session/prompt` response arrives (`stopReason` → success/cancel/error mapping).

Permission handling in ACP is interactive by design; for orchestrator usage it should be policy-driven:
- `access.auto: "high"` → auto-select an allow option if present.
- `access.auto: "low"` → auto-reject tool calls that look like edits/deletes/moves (best-effort via `ToolKind`).
- `access.network: false` → auto-reject tool calls that look like fetch/network (best-effort via `ToolKind`).
- `access.webSearch: false` → auto-reject tool calls that look like search (best-effort via `ToolKind`).
- Otherwise: expose a provider-specific callback in `SessionConfig.provider` (or a runtime-level hook) to let the orchestrator decide.

Session resume:
- Stable ACP supports `session/load` gated by `loadSession` capability.
- Draft/unstable adds richer session management (`session/resume`, `session/list`, `session/fork`).
- In `runtime-core` terms, advertise `sessionResume` only when the connected agent supports the needed method(s).

### B. Don’t rebuild runtime-core on ACP (not recommended)

Using ACP as the orchestrator’s primary abstraction tends to make ACP’s editor-centric method surface the “ceiling” for all providers, and it doesn’t cover some runtime-core goals (structured output schema, token/cost usage, provider-specific tuning). Keeping ACP as an optional backend avoids that lock-in.

## Local references (fetched into `refs/`)

Fetched on 2026-01-17:
- ACP spec + schema: `refs/acp/agent-client-protocol` (commit `7075952d4457d4ed4577cceada3b91627c0a0ea2`)
  - Stable schema: `refs/acp/agent-client-protocol/schema/schema.json` (protocol `version: 1` in `meta.json`)
  - Unstable schema: `refs/acp/agent-client-protocol/schema/schema.unstable.json`
  - Overview docs: `refs/acp/agent-client-protocol/docs/overview/introduction.mdx`, `refs/acp/agent-client-protocol/docs/overview/agents.mdx`
- TypeScript SDK: `refs/acp/typescript-sdk` (commit `477b101688b491d3731fd8f46ec39b21400c0ade`, package `@agentclientprotocol/sdk@0.13.0`)
