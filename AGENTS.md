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
- **Docs are fully published**: every page under `docs/**/*.md` must be included in the MkDocs website nav (`mkdocs.yml`). Keep user docs outside `docs/specs/`, and put implementation/developer docs under `docs/specs/`.

## Read this before making changes

| If you’re working on… | Read |
|---|---|
| where to start | `docs/docs-map.md` |
| config types / semantics | `docs/guides/config.md` |
| orchestrator wiring | `docs/guides/orchestrator.md` |
| testing strategy | `docs/specs/testing.md` |
| Claude-specific behavior | `docs/providers/claude.md` |
| Codex-specific behavior | `docs/providers/codex.md` |

Before running manual agent behavior tests (for example `uagent exec` / smoke / integration), read `docs/specs/testing.md` and follow the temporary-workspace approach to avoid damaging the user’s machine.

## Development commands

- `npm run typecheck`
- `npm run build`
- `npm test` (unit tests only; no real agent execution)
- `npm run test:smoke` (real SDK + real API calls; local)
- `npm run test:integration` (real SDK + real API calls)

## Manual verification with uagent CLI

After making changes to adapters, event mapping, or CLI output, **verify with real API requests** using the `uagent` CLI in verbose mode. This is the most reliable way to confirm functionality works end-to-end.

```bash
# Build first
npm run build

# Test with Codex
./packages/uagent/bin/uagent.js codex exec --verbose "your prompt here"

# Test with Claude
./packages/uagent/bin/uagent.js claude exec --verbose "your prompt here"
```

Useful flags for verification:
- `--verbose`: Show full agent steps (tools, reasoning, streaming output)
- `--trace`: Print unified runtime events to stderr
- `--trace-raw`: Print raw provider payloads (very verbose; implies `--trace`)
- `--reasoning-effort <level>`: Test reasoning output (`none`, `low`, `medium`, `high`, `xhigh`)

Example verification scenarios:
- **Reasoning output**: Use `--verbose --reasoning-effort high` with a prompt that triggers reasoning
- **Tool calls**: Use `--verbose` with a prompt that requires file operations or web search
- **Streaming**: Watch for smooth delta output vs. chunked/delayed text

## Integration tests (opt-in)

Integration tests make real API calls and may incur cost. Run them explicitly via `npm run test:integration`.

Auth:
- Codex: `CODEX_API_KEY` (or `OPENAI_API_KEY`) (optional: `CODEX_MODEL`, `CODEX_BASE_URL`)
- Claude: `ANTHROPIC_API_KEY` (or `ANTHROPIC_AUTH_TOKEN`) (optional: `CLAUDE_MODEL`, `ANTHROPIC_BASE_URL`)

Home directory overrides (to avoid writing to user home):
- `TEST_CLAUDE_HOME`: Override Claude home directory (default: `~/.claude`)
- `TEST_CODEX_HOME`: Override Codex home directory (default: `~/.codex`)

Note: running the full integration/smoke suites expects both providers to be configured (missing credentials will fail the run).

## Provider gotchas (practical)

### Claude SDK
- In non-interactive environments, Claude Code can fail runs due to telemetry export errors (`1P event logging: ... failed to export`), surfaced as `SDKResultError` (e.g. `subtype: error_during_execution`).
  - Mitigation for tests/CI: set `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` and `DISABLE_ERROR_REPORTING=1`.
- Structured output may take multiple turns; use `maxTurns >= 3` for output-schema tests.

### Codex SDK
- **No text streaming:** As of v0.80.0–v0.88.0, the Codex CLI does not emit streaming delta events for text content. Reasoning and agent messages appear all at once (only `item.completed` events, no `item.started`/`item.updated`). See `docs/providers/codex.md` for details.
- For predictable CI runs, prefer conservative thread defaults:
  - `sandboxMode: "read-only"`, `approvalPolicy: "never"`, `webSearchEnabled: false`, `networkAccessEnabled: false`, `skipGitRepoCheck: true`.
- Set `CODEX_HOME` to a repo-local directory (e.g. `.cache/codex-test`) to avoid writing to the user home directory.

## Debugging

- When using smoke/integration tests, Claude state/logs are written under `.cache/claude*` (debug logs in `.cache/claude*/.claude/debug/latest`).
