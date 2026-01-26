# unified-agent-sdk — agent guide

This file is the primary “how to work in this repo” context for coding agents.

## Purpose

This repo is a **unified agent runtime SDK**:
- `@unified-agent-sdk/runtime-core`: provider-agnostic TypeScript interfaces + event model (no runtime deps)
- Provider adapters that wrap upstream SDKs and translate them into a consistent `UnifiedSession.run()` + `RuntimeEvent` stream
- A small convenience package (`@unified-agent-sdk/runtime`) that exports `createRuntime()` for orchestrators

The goal is that an orchestrator can be written once against `UnifiedAgentRuntime` / `UnifiedSession` and then swap providers at the composition root.

## Repo structure (where things live)

| Area | Path | Notes |
|---|---|---|
| Core types | `packages/runtime-core/` | Keep this dependency-free; it should stay “types-first” |
| Orchestrator factory | `packages/runtime/` | Exports `createRuntime()` and re-exports core + built-in providers |
| Claude adapter | `packages/provider-claude/` | Wraps `@anthropic-ai/claude-agent-sdk` |
| Codex adapter | `packages/provider-codex/` | Wraps `@openai/codex-sdk` |
| Docs | `docs/` | Start with `docs/guides/config.md` and `docs/guides/orchestrator.md` |
| Smoke tests | `test/smoke/` | Real execution (manual / local) |
| Tests | `test/` | Unit tests + opt-in integration tests |

## Conventions / rules

- **No runtime deps in `runtime-core`**: keep it portable and easy to consume.
- **Unified-owned config stays unified-owned**: workspace and cancellation should not have “two sources of truth” in provider configs.
- **Provider differences should be explicit in types**: e.g. Codex does not support run-level provider config, so it is typed as `never`.
- **Prefer readable mapping**: adapters should map upstream events into `RuntimeEvent` in a predictable way.
- **Docs are part of the API**: if you change config semantics, update `docs/guides/config.md` and `docs/guides/orchestrator.md` in the same PR.
- **Docs are fully published**: every Markdown page under `docs/` must be included in the MkDocs website nav (`mkdocs.yml`). Keep user docs outside `docs/specs/`, and put implementation/developer docs under `docs/specs/`.

## Read this before making changes

| If you’re working on… | Read |
|---|---|
| where to start | `docs/index.md` |
| config types / semantics | `docs/guides/config.md` |
| orchestrator wiring | `docs/guides/orchestrator.md` |
| testing strategy | `docs/specs/testing.md` |
| e2e permission/access tests | `docs/specs/e2e-testing-principles.md` |
| Claude-specific behavior | `docs/providers/claude.md` |
| Codex-specific behavior | `docs/providers/codex.md` |

Before running **real-provider e2e tests** (for example permission/access verification), read `docs/specs/e2e-testing-principles.md` first.

## Development commands

- `npm run typecheck`
- `npm run build`
- `npm test` (unit tests only; no real agent execution)
- `npm run test:smoke` (real SDK + real API calls; local)
- `npm run test:integration` (real SDK + real API calls)

## Integration tests (opt-in)

Integration tests make real API calls and may incur cost. Run them explicitly via `npm run test:integration`.

Home directory overrides (to avoid writing to user home):
- `TEST_CLAUDE_HOME`: Override Claude home directory (default: `~/.claude`)
- `TEST_CODEX_HOME`: Override Codex home directory (default: `~/.codex`)
- Always use an **absolute path** for `--home` / `home` / `TEST_*_HOME` (relative paths resolve against the session `workspace.cwd` and can silently use the wrong profile).

Note: running the full integration/smoke suites expects both providers to be configured (missing credentials will fail the run).

## Provider gotchas (practical)

### Claude SDK
- In non-interactive environments, Claude Code can fail runs due to telemetry export errors (`1P event logging: ... failed to export`), surfaced as `SDKResultError` (e.g. `subtype: error_during_execution`).
  - Mitigation for tests/CI: set `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` and `DISABLE_ERROR_REPORTING=1`.
- Structured output may take multiple turns; use `maxTurns >= 3` for output-schema tests.

### Codex SDK
- **No text streaming:** As of v0.80.0–v0.88.0, the Codex CLI does not emit streaming delta events for text content. Reasoning and agent messages appear all at once (only `item.completed` events, no `item.started`/`item.updated`). See `docs/providers/codex.md` for details.
- For predictable CI runs, prefer conservative thread defaults:
  - `sandboxMode: "read-only"`, `approvalPolicy: "never"`, `skipGitRepoCheck: true`.
  - Note: unified-agent-sdk `access.auto` presets always enable Codex `webSearchEnabled` + `networkAccessEnabled`.
- Set `CODEX_HOME` to a repo-local directory (e.g. `.cache/codex-test`) to avoid writing to the user home directory.

## Debugging

- When using smoke/integration tests, Claude state/logs are written under `.cache/claude*` (debug logs in `.cache/claude*/.claude/debug/latest`).
