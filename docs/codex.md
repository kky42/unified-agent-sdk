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
  client: { apiKey: process.env.OPENAI_API_KEY, baseUrl: process.env.CODEX_BASE_URL },
  defaults: {
    // You can set provider defaults here, but prefer `SessionConfig.access`
    // for orchestrator-friendly, portable access controls.
    sandboxMode: "read-only",
    approvalPolicy: "never",
    webSearchEnabled: false,
    networkAccessEnabled: false,
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
  sessionId: "s1",
  config: {
    workspace: { cwd: process.cwd(), additionalDirs: ["/tmp"] },
    model: process.env.CODEX_MODEL,
    reasoningEffort: "medium",
    access: { auto: "medium", network: true, webSearch: true },
    provider: {
      // `CodexSessionConfig` is `ThreadOptions` minus unified-owned keys.
      // Use this for other Codex knobs; `access` is the preferred place
      // for sandbox/network/webSearch behavior.
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

Note: `auto="high"` is treated as “no restraints”; this SDK enables Codex network + web search regardless of `access.network` / `access.webSearch` in this mode.

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

## Practical tips

- Prefer setting `CODEX_HOME` to a repo-local directory (e.g. `.cache/codex`) to avoid writing to the user home directory.
- For predictable CI runs: `sandboxMode: "read-only"`, `approvalPolicy: "never"`, `webSearchEnabled: false`, `networkAccessEnabled: false`, `skipGitRepoCheck: true`.
