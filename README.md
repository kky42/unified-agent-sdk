# Unified Agent SDK

Build an orchestrator once, run it anywhere. This SDK gives you a single runtime/session API that works across providers, so you can swap **Claude** or **Codex** at the composition root without rewriting your orchestration logic.

If you’ve ever thought “I want a single agent layer that won’t lock me into one provider,” this is for you.

## Why this is different

- **One interface, many providers**: `UnifiedAgentRuntime` + `UnifiedSession` cover run lifecycle, streaming events, and structured output.
- **Portable config**: workspace, model, access, reasoning effort, output schema, cancellation.
- **Predictable event stream**: every provider maps into the same `RuntimeEvent` shape.

This is the boring, reliable core you can build real orchestrators on.

## How it works (diagram placeholder)

```
[Your App / Orchestrator]
            |
            v
   UnifiedAgentRuntime
            |
    +-------+-----------------+--------------------+
    |                         |                    |
    v                         v                    v
 Claude Adapter           Codex Adapter     (Planned) OpenCode
                                                (Planned) Gemini CLI
```

*(Replace with an image path later, e.g. `docs/assets/diagram.png`.)*

## Quick start (runtime)

Install the runtime:

```sh
npm install @unified-agent-sdk/runtime
```

Then:

```ts
import { createRuntime, SessionBusyError } from "@unified-agent-sdk/runtime";

const runtime = createRuntime({
  provider: "@openai/codex-sdk", // or "@anthropic-ai/claude-agent-sdk"
  home: null, // inherit ~/.codex or ~/.claude (unless env overrides it)
  defaultOpts: { model: "gpt-5" },
});

const session = await runtime.openSession({
  config: {
    workspace: { cwd: process.cwd() },
    reasoningEffort: "medium",
    access: { auto: "medium", network: true, webSearch: true },
  },
});

try {
  const run = await session.run({
    input: { parts: [{ type: "text", text: "Return JSON: {\"ok\": true}." }] },
    config: { outputSchema: { type: "object", additionalProperties: true } },
  });

  for await (const ev of run.events) {
    if (ev.type === "assistant.delta") process.stdout.write(ev.textDelta);
    if (ev.type === "run.completed") console.log("\n", ev.status, ev.structuredOutput);
  }
} catch (e) {
  if (e instanceof SessionBusyError) console.error("Session busy:", e.activeRunId);
  else throw e;
} finally {
  await session.dispose();
  await runtime.close();
}
```

## Try it in 60 seconds (`uagent`)

`uagent` is a tiny CLI that lets you test the runtime with real providers.

Install:

```sh
npm install -g @unified-agent-sdk/uagent
```

One‑shot exec:

```sh
mkdir -p .cache/uagent/codex
uagent codex exec \
  --home .cache/uagent/codex \
  --workspace . \
  "List the files in the workspace."
```

Interactive mode:

```sh
mkdir -p .cache/uagent/claude
uagent claude \
  --home .cache/uagent/claude \
  --workspace .
```

Verbose exec (shows tools + reasoning blocks):

```sh
mkdir -p .cache/uagent/codex
uagent codex exec \
  --home .cache/uagent/codex \
  --workspace . \
  --verbose \
  "List the files in the workspace."
```

## Unified config at a glance

| Config | Where | What it does |
|---|---|---|
| `workspace` | `openSession({ config })` | Filesystem scope for the session |
| `model` | `openSession({ config })` | Provider model id |
| `reasoningEffort` | `openSession({ config })` | Portable thinking budget |
| `access` | `openSession({ config })` | Portable permission surface |
| `outputSchema` | `run({ config })` | Structured output (JSON Schema) |
| `signal` | `run({ config })` | Cancellation |

### Access (most important for safety)

Access is unified across providers. You control it with `access.auto`, `access.network`, and `access.webSearch`.

**Presets:**

| `access.auto` | Meaning |
|---|---|
| `low` | Read‑only. Blocks edits and dangerous commands. |
| `medium` | Sandbox writes/commands inside the workspace. |
| `high` | Unrestricted (use with care). |

**Toggles:**

| Field | Effect |
|---|---|
| `access.network` | Allow outbound network (Bash/WebFetch). |
| `access.webSearch` | Allow the provider WebSearch tool. |

### Reasoning effort (portable)

Control how much “thinking” the model uses:

`none` · `low` · `medium` · `high` · `xhigh`

Example:

```ts
const session = await runtime.openSession({
  config: { reasoningEffort: "low" },
});
```

### Model selection

Models are provider‑specific but configured the same way:

```ts
const session = await runtime.openSession({
  config: { model: "gpt-5.2" },
});
```

## Provider support

- **Claude** (`@anthropic-ai/claude-agent-sdk`)
- **Codex** (`@openai/codex-sdk`)

Both map into the same runtime and event model.

**Planned:** OpenCode, Gemini CLI

## Learn more

- `docs/guides/config.md` — full config reference
- `docs/specs/permission.md` — access mapping details
- `docs/guides/orchestrator.md` — orchestration patterns
- `docs/specs/testing.md` — smoke/integration tests

**What does `--home` mean?**  
`--home` points to the provider’s config directory. It lets you keep per‑profile settings
and auth separate (for example, `.profiles/codex/yescode` or `.profiles/claude/yescode`).
If omitted, the provider uses its default location (e.g. `~/.codex` or `~/.claude`). The
directory must already exist; `uagent` will not create it.
