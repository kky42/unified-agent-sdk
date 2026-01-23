# Orchestrator wiring

Write your orchestrator against the **unified interfaces**:
- `UnifiedAgentRuntime` (creates sessions)
- `UnifiedSession` (runs turns and emits `RuntimeEvent`s)

Then choose the concrete provider runtime at the composition root.

## Recommended shape

| Concern | Where it lives |
|---|---|
| Provider selection (`claude` vs `codex`) | composition root |
| Workspace scope (`workspace.cwd`, `workspace.additionalDirs`) | `openSession()` |
| Access (`access.*`) | `openSession()` |
| Structured output (`outputSchema`) + cancellation (`signal`) | `run()` |
| Provider-specific knobs | `SessionConfig.provider` (and sometimes `RunConfig.provider`) |

## `createRuntime()` (built-in factory)

`@unified-agent-sdk/runtime` exports `createRuntime()` which returns a correctly-typed runtime instance.

`createRuntime()` is intentionally thin:
- Provider auth/endpoint/home is configured via `home` + `env` (so CLI users can reuse `~/.codex` / `~/.claude`).
- If `home` is provided, the directory must already exist; the runtime will not create it.
- Unified knobs (like `reasoningEffort`) live on `openSession({ config: { ... } })` (or `createRuntime({ defaultOpts: ... })`).
- For Claude, `createRuntime()` sets `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` by default for more reliable non-interactive runs (override via `env`).

```ts
import { createRuntime, type TurnInput } from "@unified-agent-sdk/runtime";

const runtime = createRuntime({
  provider: "@openai/codex-sdk",
  home: null, // inherit ~/.codex (or existing CODEX_HOME)
  defaultOpts: { model: "gpt-5" },
});

const session = await runtime.openSession({
  config: {
    workspace: { cwd: process.cwd() },
    reasoningEffort: "medium",
    access: { auto: "medium" },
    provider: {},
  },
});

const input: TurnInput = { parts: [{ type: "text", text: "Say hello." }] };
const run = await session.run({ input });
for await (const ev of run.events) console.log(ev.type);

await session.dispose();
await runtime.close();
```

## Provider differences (typed on purpose)

| Provider | `SessionConfig.provider` | `RunConfig.provider` |
|---|---|---|
| Claude | `ClaudeSessionConfig` | `Partial<ClaudeSessionConfig>` (best-effort merge) |
| Codex | `CodexSessionConfig` | `never` (not supported) |

Notes:
- `UnifiedSession.run()` starts immediately; `RunHandle.result` settles even if you don't consume `RunHandle.events` (see [Testing](../specs/testing.md)).
- `RunHandle.events` is a single-consumer stream; consume it promptly for streaming output/telemetry.
- A `UnifiedSession` supports one active `run()` at a time; concurrent calls throw `SessionBusyError` (queue/schedule in your orchestrator).
- `SessionConfig.access` is mapped into provider-native enforcement and does not behave identically across providers (see [Access](../specs/permission.md)).
- If your orchestrator needs HTTP via shell tools (for example `curl` to `localhost`), use `access.auto="medium"` (portable); `auto="low"` is intentionally conservative.
