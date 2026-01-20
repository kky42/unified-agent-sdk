# Docs Map

Everything under `docs/` is published on the project website (MkDocs, see `mkdocs.yml`).

This folder serves **two audiences**:

| Audience | What you want | Where to start |
|---|---|---|
| **SDK / CLI users** | How to use unified-agent-sdk and `uagent`, plus evidence you can trust portability | `index.md`, `getting-started.md`, `guides/`, `experiments/` |
| **Repo developers** | Implementation-level details: mappings, invariants, and testing strategy | `specs/` |

## Page index (every page is in the website nav)

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
| `experiments/access.md` | Users | Access/sandbox behavior across providers |
| `experiments/inflight-reconfiguration.md` | Users | Mid-session config changes (snapshot/resume) |
| `specs/testing.md` | Devs | Unit/smoke/integration strategy |
| `specs/permission.md` | Devs | How `access` maps per provider |
| `specs/event-mapping.md` | Devs | Adapter event mapping guidelines |
| `specs/instruction-discovery.md` | Devs | Instruction sources + precedence |
| `specs/acp.md` | Devs | ACP design notes |
| `specs/contributing.md` | Devs | Repo contribution notes |

## Conventions

- User-facing docs live outside `specs/`.
- Implementation/developer docs live under `specs/`.
- When you add/rename a doc page, update `mkdocs.yml` in the same PR.
- Validate with `mkdocs build --strict` (CI runs this).
