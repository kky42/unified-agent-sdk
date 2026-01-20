# Unified Agent SDK

Build an orchestrator once, run it anywhere.

This repo provides a provider-agnostic runtime/session API so you can swap **Claude** or **Codex** at the composition root without rewriting orchestration logic.

```
Orchestrator
   |
   v
UnifiedSession.run()  ->  RuntimeEvent stream
   |
   +--> provider-codex  -> @openai/codex-sdk
   |
   +--> provider-claude -> @anthropic-ai/claude-agent-sdk
```

## Choose your path

| You are… | Start here | Then |
|---|---|---|
| Using the **SDK** in your app | [Getting Started](getting-started.md) | [Guides](guides/config.md), [Use Cases](use-cases.md) |
| Using **`uagent`** as a daily driver | [uagent CLI (Interactive)](guides/interactive.md) | [Events](guides/events.md), [Access](guides/config.md) |
| Contributing to this repo | [Specs](specs/testing.md) | Testing + mapping specs |

## Quick start

Install:

```sh
npm install @unified-agent-sdk/runtime
```

Run (TypeScript):

```ts
import { createRuntime } from "@unified-agent-sdk/runtime";

const runtime = createRuntime({
  provider: "@openai/codex-sdk", // or "@anthropic-ai/claude-agent-sdk"
  home: null,
  defaultOpts: { model: "gpt-5" },
});

const session = await runtime.openSession({
  config: {
    workspace: { cwd: process.cwd() },
    reasoningEffort: "medium",
    access: { auto: "medium", network: true, webSearch: true },
  },
});

const run = await session.run({
  input: { parts: [{ type: "text", text: "Return JSON: {\"ok\": true}." }] },
  config: { outputSchema: { type: "object", additionalProperties: true } },
});

for await (const ev of run.events) {
  if (ev.type === "assistant.delta") process.stdout.write(ev.textDelta);
  if (ev.type === "run.completed") console.log("\n", ev.status, ev.structuredOutput);
}

await session.dispose();
await runtime.close();
```

Next:
- Start with [Getting Started](getting-started.md)
- Browse [Use Cases](use-cases.md) and [Guides](guides/config.md)
- Check [Experiments](experiments/index.md) for portability/sandbox findings
- For implementation details, see [Specs](specs/testing.md)
