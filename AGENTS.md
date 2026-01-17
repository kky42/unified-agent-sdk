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
| Docs | `docs/` | Start with `docs/config.md` and `docs/orchestrator.md` |
| Smoke tests | `test/smoke/` | Real execution (manual / local) |
| Tests | `test/` | Unit tests + opt-in integration tests |

## Conventions / rules

- **No runtime deps in `runtime-core`**: keep it portable and easy to consume.
- **Unified-owned config stays unified-owned**: workspace and cancellation should not have “two sources of truth” in provider configs.
- **Provider differences should be explicit in types**: e.g. Codex does not support run-level provider config, so it is typed as `never`.
- **Prefer readable mapping**: adapters should map upstream events into `RuntimeEvent` in a predictable way.
- **Docs are part of the API**: if you change config semantics, update `docs/config.md` and `docs/orchestrator.md` in the same PR.

## Read this before making changes

| If you’re working on… | Read |
|---|---|
| where to start | `docs/README.md` |
| config types / semantics | `docs/config.md` |
| orchestrator wiring | `docs/orchestrator.md` |
| testing strategy | `docs/testing.md` |
| Claude-specific behavior | `docs/claude.md` |
| Codex-specific behavior | `docs/codex.md` |

Before running manual agent behavior tests (for example `uagent exec` / smoke / integration), read `docs/testing.md` and follow the temporary-workspace approach to avoid damaging the user’s machine.

## Development commands

- `npm run typecheck`
- `npm run build`
- `npm test` (unit tests only; no real agent execution)
- `npm run test:smoke` (real SDK + real API calls; local)
- `npm run test:integration` (real SDK + real API calls)

## Integration tests (opt-in)

Integration tests make real API calls and may incur cost. Run them explicitly via `npm run test:integration`.

Auth:
- Codex: `CODEX_API_KEY` (or `OPENAI_API_KEY`) (optional: `CODEX_MODEL`, `CODEX_BASE_URL`)
- Claude: `ANTHROPIC_API_KEY` (or `ANTHROPIC_AUTH_TOKEN`) (optional: `CLAUDE_MODEL`, `ANTHROPIC_BASE_URL`)

Note: running the full integration/smoke suites expects both providers to be configured (missing credentials will fail the run).

## Provider gotchas (practical)

### Claude SDK
- In non-interactive environments, Claude Code can fail runs due to telemetry export errors (`1P event logging: ... failed to export`), surfaced as `SDKResultError` (e.g. `subtype: error_during_execution`).
  - Mitigation for tests/CI: set `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` and `DISABLE_ERROR_REPORTING=1`.
- Structured output may take multiple turns; use `maxTurns >= 3` for output-schema tests.

### Codex SDK
- For predictable CI runs, prefer conservative thread defaults:
  - `sandboxMode: "read-only"`, `approvalPolicy: "never"`, `webSearchEnabled: false`, `networkAccessEnabled: false`, `skipGitRepoCheck: true`.
- Set `CODEX_HOME` to a repo-local directory (e.g. `.cache/codex-test`) to avoid writing to the user home directory.

## Debugging

- When using smoke/integration tests, Claude state/logs are written under `.cache/claude*` (debug logs in `.cache/claude*/.claude/debug/latest`).
