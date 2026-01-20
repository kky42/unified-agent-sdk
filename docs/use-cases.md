# Use Cases & Examples

This page shows common ways people use unified-agent-sdk in real projects (SDK) and day-to-day (CLI).

## 1) Daily agent driver: `uagent` CLI

Use `uagent` when you want an interactive TUI that streams unified `RuntimeEvent`s.

```sh
npm run build
node packages/uagent/bin/uagent.js codex --workspace . --home ~/.codex --verbose
```

See: [uagent CLI (Interactive)](guides/interactive.md)

## 2) One orchestrator, multiple providers

Keep orchestration code provider-agnostic and pick the provider at the composition root:

```ts
import { createRuntime } from "@unified-agent-sdk/runtime";

const runtime = createRuntime({
  provider: process.env.PROVIDER === "claude" ? "@anthropic-ai/claude-agent-sdk" : "@openai/codex-sdk",
  home: null,
  defaultOpts: { model: "gpt-5" },
});
```

See: [Orchestrator wiring](guides/orchestrator.md), [Providers](providers/codex.md)

## 3) Structured output (JSON Schema)

Use `RunConfig.outputSchema` when you want a machine-checked result:

```ts
const run = await session.run({
  input: { parts: [{ type: "text", text: "Return JSON: {\"ok\": true}." }] },
  config: { outputSchema: { type: "object", additionalProperties: true } },
});
```

See: [Structured Output](guides/structured-output.md)

## 4) “Portable safety knobs” via `access`

Use `SessionConfig.access` to express intent (read-only vs sandboxed vs unrestricted) in a provider-agnostic way:

```ts
const session = await runtime.openSession({
  config: { access: { auto: "medium", network: false, webSearch: false } },
});
```

See: [Configuration](guides/config.md), [Access & Sandboxing experiments](experiments/access.md), [Permission mapping (spec)](specs/permission.md)

