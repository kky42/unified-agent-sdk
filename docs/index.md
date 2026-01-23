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
    access: { auto: "medium" },
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

## Docs map

Everything under `docs/` is published on the project website (MkDocs; see `mkdocs.yml`).

This folder serves two audiences:

| Audience | What you want | Where to start |
|---|---|---|
| **SDK / CLI users** | How to use unified-agent-sdk and `uagent`, plus evidence you can trust portability | `index.md`, `getting-started.md`, `guides/`, `experiments/` |
| **Repo developers** | Implementation details: mappings, invariants, and testing strategy | `specs/` |

### Page index

| Page | Audience | What it contains |
|---|---|---|
| `index.md` | Users | Homepage + quick start |
| `getting-started.md` | Users | Install + first session |
| `use-cases.md` | Users | Practical examples (SDK + CLI) |
| `guides/config.md` | Users | Unified vs provider config + key semantics |
| `guides/orchestrator.md` | Users | Provider-agnostic orchestrator wiring |
| `guides/interactive.md` | Users | `uagent` CLI (interactive runner) |
| `guides/sessions.md` | Users | Sessions, lifecycle, resume |
| `guides/events.md` | Users | `RuntimeEvent` model + provider mapping summary |
| `guides/structured-output.md` | Users | JSON Schema structured output |
| `providers/codex.md` | Users | Codex adapter notes + configuration |
| `providers/claude.md` | Users | Claude adapter notes + configuration |
| `reference/packages.md` | Users | Package inventory + what to import |
| `experiments/index.md` | Users | Experiment overview |
| `experiments/2026-01-23-access-sandboxing.md` | Users | Consolidated into the permission e2e report (kept for backward links) |
| `experiments/2026-01-20-inflight-session-reconfiguration.md` | Users | Mid-session config changes (snapshot/resume) |
| `experiments/2026-01-23-permission-e2e-testing.md` | Users | Point-in-time e2e matrix for permissions/access |
| `specs/testing.md` | Devs | Unit/smoke/integration strategy |
| `specs/e2e-testing-principles.md` | Devs | Principles + pitfalls for real-provider e2e testing |
| `specs/permission.md` | Devs | How `access.auto` maps per provider |
| `specs/event-mapping.md` | Devs | Adapter event mapping guidelines |
| `specs/instruction-discovery.md` | Devs | Instruction sources + precedence |
| `specs/acp.md` | Devs | ACP design notes |
| `specs/contributing.md` | Devs | Repo contribution notes |

### Conventions

- User-facing docs live outside `specs/`.
- Implementation/developer docs live under `specs/`.
- Experiments use date-prefixed filenames: `YYYY-MM-DD-{title}.md`.
- Legacy experiments include `legacy` in the filename: `YYYY-MM-DD-legacy-{title}.md`.
- When you add/rename a doc page, update `mkdocs.yml` in the same PR.
