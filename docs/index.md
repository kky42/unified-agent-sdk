# Unified Agent SDK

Build an orchestrator once, run it anywhere.

This repo provides a provider-agnostic runtime/session API so you can swap **Claude** or **Codex** at the composition root without rewriting orchestration logic.

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
- Start with **Getting Started**
- Then follow **Guides** for sessions/events/config/structured output
- Provider-specific details live under **Providers**

Dev + design docs live under **Specs** (mappings, testing, contributor notes).
