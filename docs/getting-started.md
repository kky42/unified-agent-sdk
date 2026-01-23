# Getting Started

## Choose an entrypoint

Most orchestrators should depend on:
- `@unified-agent-sdk/runtime` (exports `createRuntime()` + re-exports core types)

If you want provider-specific wiring only:
- `@unified-agent-sdk/provider-codex`
- `@unified-agent-sdk/provider-claude`

## Install

```sh
npm install @unified-agent-sdk/runtime
```

## Provide credentials

This SDK delegates auth to the upstream provider SDKs/CLIs.

- Codex: set `OPENAI_API_KEY` (or `CODEX_API_KEY`)
- Claude: set `ANTHROPIC_API_KEY` (or `ANTHROPIC_AUTH_TOKEN`)

## Run your first session

```ts
import { createRuntime } from "@unified-agent-sdk/runtime";

const runtime = createRuntime({
  provider: "@openai/codex-sdk", // or "@anthropic-ai/claude-agent-sdk"
  home: null, // inherit ~/.codex or ~/.claude (unless env overrides it)
  defaultOpts: { model: "gpt-5" },
});

const session = await runtime.openSession({
  config: {
    workspace: { cwd: process.cwd() },
    access: { auto: "medium" },
  },
});

const run = await session.run({
  input: { parts: [{ type: "text", text: "Say hello." }] },
});

for await (const ev of run.events) {
  if (ev.type === "assistant.delta") process.stdout.write(ev.textDelta);
  if (ev.type === "run.completed") console.log("\n", ev.status);
}

await session.dispose();
await runtime.close();
```
