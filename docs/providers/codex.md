# Codex provider notes

This repo’s Codex adapter (`@unified-agent-sdk/provider-codex`) wraps `@openai/codex-sdk` and maps it into the unified `UnifiedSession.run()` + `RuntimeEvent` stream.

## At a glance

| Concern | Where to configure it |
|---|---|
| Runtime defaults (sandbox, approvals, web search, etc.) | `new CodexRuntime({ defaults: ThreadOptions })` |
| Client connection/auth (`apiKey`, `baseUrl`) | `new CodexRuntime({ client: CodexOptions })` |
| Session model | `openSession({ config: { model } })` |
| Reasoning effort | `openSession({ config: { reasoningEffort } })` |
| Per-session options (minus unified-owned keys: `workingDirectory`, `additionalDirectories`, `model`) | `openSession({ config: { provider: CodexSessionConfig } })` |
| Workspace scope | `openSession({ config: { workspace } })` |
| Unified access | `openSession({ config: { access } })` |
| Per-run structured output + cancellation | `run({ config: { outputSchema, signal } })` |
| Run-level provider config | **Not supported** (`RunConfig.provider` is typed as `never`) |

## Configuration in this SDK

### Runtime

```ts
import { CodexRuntime } from "@unified-agent-sdk/provider-codex";

const runtime = new CodexRuntime({
  defaults: {
    // You can set provider defaults here, but prefer `SessionConfig.access`
    // for orchestrator-friendly, portable access controls.
    sandboxMode: "read-only",
    approvalPolicy: "never",
  },
});
```

### Session

In the unified SDK, workspace maps to Codex thread options:

| Unified | Codex |
|---|---|
| `workspace.cwd` | `ThreadOptions.workingDirectory` |
| `workspace.additionalDirs` | `ThreadOptions.additionalDirectories` |

```ts
const session = await runtime.openSession({
  config: {
    workspace: { cwd: process.cwd(), additionalDirs: ["/tmp"] },
    model: process.env.CODEX_MODEL,
    reasoningEffort: "medium",
    access: { auto: "medium" },
    provider: {
      // `CodexSessionConfig` is `ThreadOptions` minus unified-owned keys.
      // Use this for other Codex knobs; `access.auto` is the preferred place
      // for portable sandbox behavior.
    },
  },
});
```

### Run

```ts
const run = await session.run({
  input: { parts: [{ type: "text", text: "Say hello." }] },
  config: { outputSchema: { type: "object" } },
});
```

#### Images and ordering

Codex attaches images to the initial prompt (via `--image`) and does not support true text↔image interleaving. When you pass `local_image` parts, this SDK injects stable placeholders like `[Image #1]` into the prompt text at the position where each image appeared, and attaches images in the same encounter order (Image #1 = first attached image, etc.).

#### Non-object root schemas

For portability, prefer schemas with an object root. If you pass a non-object root schema (for example `type: "array"`), this SDK will transparently wrap it under `{ "value": ... }` for Codex and then unwrap `run.completed.structuredOutput` back to your requested shape.

## Sandbox + approvals (how Codex controls access)

`@openai/codex-sdk` spawns the bundled `codex` CLI. Sandbox + approval behavior is enforced by the CLI (config files + flags) and exposed to the SDK via `ThreadOptions`.

Key knobs you can set in `ThreadOptions` / `CodexSessionConfig`:

### Sandbox (`sandboxMode`)

Controls the policy for model-generated shell commands:
- `"read-only"`: “browse mode” (safe by default; edits/commands require approval).
- `"workspace-write"`: allows edits + command execution in the working directory and any `additionalDirectories`.
- `"danger-full-access"`: removes sandbox restrictions (use with extreme caution).

#### How unified `access.auto` maps to `sandboxMode`

When using `@unified-agent-sdk/runtime` / `SessionConfig.access`, the Codex adapter maps:
- `auto="low"` → `sandboxMode: "read-only"`
- `auto="medium"` → `sandboxMode: "workspace-write"`
- `auto="high"` → `sandboxMode: "danger-full-access"` (**unsafe; unrestricted**)

Practical note: on current Codex builds, `sandboxMode="read-only"` may block shell networking (for example `curl` to `http://127.0.0.1:...`). Use `auto="medium"` when you need local HTTP APIs.

Note: some Codex builds treat `"danger-full-access"` as broadly permissive regardless of other toggles (including network).

### Approvals (`approvalPolicy`)

Controls when Codex pauses for approval before executing a command:
- `"on-request"`: the model requests approval when it thinks it needs it (default behavior).
- `"untrusted"`: only auto-runs known-safe read-only commands; prompts for other commands.
- `"on-failure"`: auto-runs in the sandbox; prompts only on failure (for escalation).
- `"never"`: never prompts (any operation that would have asked will be denied/blocked).

### Network vs web search

Codex separates “local network” from “web search”:
- `networkAccessEnabled` toggles network access for commands in the `workspace-write` sandbox (`sandbox_workspace_write.network_access`).
- `webSearchEnabled` toggles Codex’s `web_search` tool (`features.web_search_request` / `--search`), which is separate from local network access.

Note: unified-agent-sdk’s `access.auto` presets always enable both network + web search; there is no unified toggle to disable either.

### Mapping (SDK → Codex CLI/config)

| Codex SDK (`ThreadOptions`) | Codex CLI flag / config key |
|---|---|
| `sandboxMode` | `--sandbox` / `sandbox_mode` |
| `approvalPolicy` | `--ask-for-approval` / `approval_policy` |
| `workingDirectory` | `--cd` |
| `additionalDirectories` | `--add-dir` / `sandbox_workspace_write.writable_roots` |
| `networkAccessEnabled` | `sandbox_workspace_write.network_access` |
| `webSearchEnabled` | `--search` / `features.web_search_request` |

### Global config (still applies)

Codex also reads global configuration (for example `~/.codex/config.toml`), and deployments can enforce repo-level constraints via `requirements.toml` (for example “always read-only” or “never bypass approvals”). If you need settings beyond what `ThreadOptions` exposes, set them in Codex’s config files.

## Injecting “system prompt” style instructions

Codex’s “system prompt” equivalent comes from the **Codex CLI** (which `@openai/codex-sdk` spawns). In practice, you inject persistent instructions via **instruction files + config**, not via a per-turn `systemPrompt` parameter.

Common approaches:

- **Per-repo / per-directory instructions:** add `AGENTS.md` files in your repo (more-specific nested `AGENTS.md` applies to its subtree).
- **Global / profile defaults:** set `CODEX_HOME` (defaults to `~/.codex`) and put config + instruction files there (for example `config.toml`, `AGENTS.md`, `AGENTS.override.md`).
- **Config-based injection:** set `developer_instructions` (for example in `config.toml`, or via the CLI `-c` / `--config` override flag).
- **Experimental override:** `experimental_instructions_file` can be used to point Codex at a replacement instruction file (advanced/experimental).

If you’re embedding Codex via the unified runtime, `createRuntime({ provider: "@openai/codex-sdk", home: "/path" })` sets `CODEX_HOME` for the spawned Codex CLI process. If you’re using `CodexRuntime` directly, set it via `new CodexRuntime({ client: { env: { CODEX_HOME: "..." } } })` (the `env` is passed to the underlying `@openai/codex-sdk` client).

Note: always use an **absolute path** for `CODEX_HOME` / `home` / `--home`. Relative paths are resolved against the process working directory and can silently create/use a different profile directory.

## Streaming behavior

### Current limitation: no text streaming

As of `@openai/codex-sdk` v0.80.0–v0.88.0, **the Codex CLI does not emit streaming delta events for text content**. When using `--json` mode, the CLI outputs:

```jsonl
{"type":"thread.started","thread_id":"..."}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"full text here"}}
{"type":"turn.completed","usage":{...}}
```

Notice there are no `item.started` or `item.updated` events for incremental text streaming. The full text only becomes available when `item.completed` is emitted.

**Impact:** Reasoning and agent message text appear all at once rather than streaming character-by-character. This differs from Claude, which streams text incrementally.

### Adapter infrastructure

This adapter already has infrastructure to handle streaming if/when the Codex SDK supports it:

- `computeAgentDelta()` and `computeReasoningDelta()` track previous text and compute deltas
- `item.started` and `item.updated` events are handled and would emit `assistant.delta` / `assistant.reasoning.delta` events

When the Codex SDK adds streaming support, this adapter should work automatically.

### Future: streaming events (PR #5546)

[PR #5546](https://github.com/openai/codex/pull/5546) "Add item streaming events" was merged in October 2025, adding:
- `AgentMessageContentDelta`
- `ReasoningContentDelta`
- `ReasoningRawContentDelta`

These events are not yet exposed in the TypeScript SDK types. Monitor [Codex releases](https://github.com/openai/codex/releases) for when this becomes available.

## Practical tips

- Prefer setting `CODEX_HOME` to a repo-local directory (e.g. `.cache/codex`) to avoid writing to the user home directory.
- For predictable CI runs: `sandboxMode: "read-only"`, `approvalPolicy: "never"`, `skipGitRepoCheck: true`.
  - Note: unified-agent-sdk `access.auto` presets always enable `webSearchEnabled` + `networkAccessEnabled`.
