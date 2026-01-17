# Claude provider notes

This repo’s Claude adapter (`@unified-agent-sdk/provider-claude`) wraps `@anthropic-ai/claude-agent-sdk` and maps it into the unified `UnifiedSession.run()` + `RuntimeEvent` stream.

## At a glance

| Concern | Where to configure it |
|---|---|
| Runtime defaults (system prompt, env, hooks, etc.) | `new ClaudeRuntime({ defaults: ClaudeOptions })` (minus unified-owned keys: `cwd`, `additionalDirectories`, `resume`, `abortController`, `model`) |
| Session model | `openSession({ config: { model } })` |
| Per-session options (minus unified-owned keys: `cwd`, `additionalDirectories`, `resume`, `abortController`, `model`) | `openSession({ config: { provider: ClaudeSessionConfig } })` |
| Workspace scope | `openSession({ config: { workspace } })` |
| Unified access | `openSession({ config: { access } })` |
| Per-run overrides | `run({ config: { provider: Partial<ClaudeSessionConfig> } })` (best-effort merge) |
| Structured output | `run({ config: { outputSchema } })` |
| Cancellation | `run({ config: { signal } })` |

## Configuration in this SDK

### Runtime

```ts
import { ClaudeRuntime } from "@unified-agent-sdk/provider-claude";

const runtime = new ClaudeRuntime({
  defaults: {
    systemPrompt: "You are a concise assistant.",
    includePartialMessages: true,
    extraArgs: { print: null },
    env: { ...process.env },
  },
});
```

#### Injecting system prompt + persistent project instructions

`@anthropic-ai/claude-agent-sdk` supports a first-class `systemPrompt` option:

- `systemPrompt: "..."` for a fully custom system prompt
- `systemPrompt: { type: "preset", preset: "claude_code" }` to use Claude Code’s built-in prompt
- `systemPrompt: { type: "preset", preset: "claude_code", append: "..." }` to append your own rules to the built-in prompt

To load persistent project instructions from `CLAUDE.md`, you must opt in via `settingSources` (include `"project"`). In the unified SDK, `settingSources` is part of `ClaudeSessionConfig` / `ClaudeRuntime` defaults (see “Settings files” below).

### Session

In the unified SDK, workspace maps to Claude options:

| Unified | Claude |
|---|---|
| `workspace.cwd` | `Options.cwd` |
| `workspace.additionalDirs` | `Options.additionalDirectories` |

```ts
const session = await runtime.openSession({
  sessionId: "s1",
  config: {
    workspace: { cwd: process.cwd() },
    model: process.env.CLAUDE_MODEL,
    access: { auto: "medium", network: true, webSearch: true },
    provider: {
      // `ClaudeSessionConfig` is Claude `Options` minus unified-owned keys,
      // plus `resumeSessionId?` convenience.
    },
  },
});
```

### Run

```ts
const run = await session.run({
  input: { parts: [{ type: "text", text: "Return JSON with {\"ok\": true}." }] },
  config: {
    outputSchema: { type: "object", additionalProperties: true },
    provider: {
      // Optional run-level overrides (best-effort merge), e.g. adjust `maxTurns`.
      maxTurns: 3,
    },
  },
});
```

#### Thinking / “think mode”

In `@anthropic-ai/claude-agent-sdk`, “think mode” (aka thinking) is controlled by the thinking-token budget (`maxThinkingTokens`). In this unified SDK, it is configured via the unified `reasoningEffort` preset.

In this unified SDK, you can set it at:

```ts
import { createRuntime } from "@unified-agent-sdk/runtime";

// 1) Runtime defaults (applies to every session unless overridden)
const runtime = createRuntime({
  provider: "@anthropic-ai/claude-agent-sdk",
  defaultOpts: { reasoningEffort: "none" }, // maps to maxThinkingTokens=0 (disable thinking)
});

// 2) Session-level override
await runtime.openSession({
  sessionId: "s1",
  config: { reasoningEffort: "high" }, // maps to maxThinkingTokens=12000
});
```

Mapping details are documented in `docs/config.md` under “Unified reasoning config”.

Note: If you are using the Anthropic **Messages API** directly (not the Claude Agent SDK / Claude Code), “extended thinking” is configured via the `thinking` request parameter rather than `maxThinkingTokens`.

#### Non-object root schemas

Some structured-output backends are most reliable when the schema root is a JSON object. If you pass a non-object root schema (for example `type: "array"`), this SDK will transparently wrap it under `{ "value": ... }` for the provider and then unwrap `run.completed.structuredOutput` back to your requested shape.

## Permissions + sandbox (how Claude Code controls access)

`@anthropic-ai/claude-agent-sdk` runs Claude Code and inherits its permission + sandbox system. There are three main layers:

1) **Settings files** (what permissions exist, and what gets auto-approved)
2) **Permission modes** (how the session behaves when permission is required)
3) **Per-tool handlers/hooks** (optional programmatic approvals)

### Settings files (`settingSources`)

The upstream SDK only loads Claude Code filesystem settings when you opt in via `settingSources`.

| `settingSources` value | Loads |
|---|---|
| `"user"` | Global user settings (`~/.claude/settings.json`) |
| `"project"` | Project settings (`.claude/settings.json`) (required to load `CLAUDE.md`) |
| `"local"` | Local settings (`.claude/settings.local.json`) |

#### How these map in the unified SDK

- `"user"` reads from:
  - `${CLAUDE_CONFIG_DIR}/settings.json` when `CLAUDE_CONFIG_DIR` is set, otherwise
  - `~/.claude/settings.json` (OS home).
- `"project"` (and `"local"`) read from `.claude/...` relative to the Claude Code working directory (`Options.cwd`).
  - In the unified SDK, `Options.cwd` comes from `openSession({ config: { workspace: { cwd } } })`.

To load a `CLAUDE.md` that lives in your workspace, ensure `workspace.cwd` is the directory that contains that `CLAUDE.md`.

If you want to *relocate* user settings (instead of using `~/.claude`), set `CLAUDE_CONFIG_DIR` (or pass `home` to `createRuntime()` in `@unified-agent-sdk/runtime`).

### Permission rules (what is allowed/asked/denied)

Claude Code permissions are defined in settings (for example `.claude/settings.json`) using allow/ask/deny rules for tools like `Read`, `Edit`, `Bash`, and `WebFetch`. For example:

- If you want Claude to *write* outside the working directory, you must allow `Edit` for those paths.
- If you want Claude to *fetch from the internet*, you must allow `WebFetch` (and optionally configure sandbox network access).

### Permission prompts + modes (`permissionMode`)

`permissionMode` controls how Claude behaves when a tool execution needs approval:

- `"default"`: standard behavior (prompts for dangerous operations)
- `"acceptEdits"`: auto-accept file edit operations
- `"dontAsk"`: never prompt; deny if not pre-approved by rules
- `"bypassPermissions"`: bypass permission checks (requires `allowDangerouslySkipPermissions: true`)

When embedding Claude Code, the SDK evaluates permissions in this order:
1) hooks (`PreToolUse`, `PermissionRequest`) if present
2) permission rules (deny → allow → ask)
3) `permissionMode`
4) `canUseTool` callback

### Sandbox settings (`sandbox`)

Claude Code can also execute tools in an isolation sandbox. The `sandbox` option controls sandbox behavior (enabled, implementation mode, output limits, etc.). Access restrictions are still enforced by permission rules (for example `Read`/`Edit` and `WebFetch`) rather than by sandbox settings alone.

## Practical tips

- In non-interactive environments, Claude Code can fail due to telemetry export errors.
  - Mitigation for CI: set `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` and `DISABLE_ERROR_REPORTING=1`.
  - If you use `@unified-agent-sdk/runtime` `createRuntime()`, this SDK sets `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` by default (override via `createRuntime({ env: { ... } })`).
- Structured output may take multiple turns; prefer `maxTurns >= 3` for schema-based runs.
