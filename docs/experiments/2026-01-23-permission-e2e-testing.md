# Permission E2E Testing (Real Providers)

This page is a **point-in-time behavioral report** of unified-agent-sdk access controls:
- `workspace` / `additionalDirs`
- `access.auto` (`low` | `medium` | `high`)

Unified `access.auto` intent:
- `low`: read-only + WebSearch (when supported); shell networking (for example `curl`) is intentionally conservative
- `medium`: workspace-write sandbox + WebSearch + network (including `localhost` / `127.0.0.1`)
- `high`: unrestricted / bypass (use with caution)

> These are behavioral results (real provider CLIs, real API calls). Treat them as portable intent + provider differences, not a security boundary.

## How to run

Run the repo-local matrix runner:

```sh
node scripts/permission-e2e-run.js
```

It writes a `results.json` under:
- `$PWD/.cache/test/permission-e2e-<timestamp>/results.json`

The runner:
1) creates isolated workspaces
2) tests read behavior (workspace vs `--add-dir` vs outside)
3) tests write behavior (workspace vs `--add-dir` vs outside)
4) starts a local HTTP server and tests `curl` to `127.0.0.1` + `localhost`
5) tests the provider `WebSearch` tool

## Provider notes (practical)

- **Codex**: on some macOS setups, paths under `/tmp` may be writable even when outside your configured workspace; use a temp directory under your project directory if you’re verifying “outside-workspace writes are blocked”.
- **Codex**: `auto="low"` (`sandboxMode="read-only"`) blocks `curl`; use `auto="medium"` for local HTTP APIs.
- **Claude**: `auto="low"` denies network-capable `Bash` commands (like `curl`) for portability with Codex `auto="low"`.
- **Claude**: Claude Code sandbox networking is allow-list driven; in `auto="medium"` this repo’s adapter includes `localhost` / `127.0.0.1` / `::1` so local HTTP APIs work.

## Reading behavior test (details)

For each `provider × auto × target` where:
- `auto ∈ { low, medium, high }`
- `target ∈ { workspace, add, outside }`

The runner:
1) creates three directories under a case directory:
   - `workspace/` (passed via `--workspace`)
   - `add/` (passed via `--add-dir` only for the `add` target)
   - `outside/` (not passed to the provider as a workspace root)
2) writes a unique marker line to a target file path (outside of the agent sandbox)
3) prompts the agent to use `Bash` to run:

```sh
cat '<targetPath>'
```

Then it asks the agent to output:
- `READ=<first line>` on success
- `READ=READ_DENIED` on failure

Classification rule: the runner treats the read as `ok` only if the agent outputs the exact marker **and** the run log indicates the `Bash` tool was used.

## Writing behavior test (details)

For each `provider × auto × target` where:
- `auto ∈ { low, medium, high }`
- `target ∈ { workspace, add, outside }`

The runner:
1) creates three directories under a case directory:
   - `workspace/` (passed via `--workspace`)
   - `add/` (passed via `--add-dir` only for the `add` target)
   - `outside/` (not passed to the provider as a workspace root)
2) chooses a unique marker (e.g. `WRITE_<provider>_<auto>_<target>_<timestamp>`) and a target file path:
   - `workspace` target → `${workspace}/<marker>.txt`
   - `add` target → `${add}/<marker>.txt`
   - `outside` target → `${outside}/<marker>.txt`
3) prompts the agent to use `Bash` to run **exactly**:

```sh
printf '<marker>' > '<targetPath>'
```

Classification rule (important): the runner **does not trust** the model’s narration. It checks the filesystem:
- `okAtTarget = true` only if the file exists at the requested `targetPath`
- if not, it also records `redirectedPath` (best-effort) if the agent wrote the file somewhere else

## Results JSON

The `results.json` file contains three per-provider arrays:
- `readResults`: read status + classification metadata
- `writeResults`: write succeeded to requested path or not (with redirect detection)
- `netResults`: `loopback` + `localhost` curl status and WebSearch status

See also:
- [Access & Sandboxing experiments](2026-01-23-access-sandboxing.md)
- [E2E testing principles](../specs/e2e-testing-principles.md)

## Latest matrix run (2026-01-23, Claude home=~/.claude)

Run directory: `$PWD/.cache/test/permission-e2e-20260123-120134`

### Reads (workspace vs add-dir vs outside)

| Provider | `auto=low` | `auto=medium` | `auto=high` |
|---|---|---|---|
| Codex | ✅/✅/✅ | ✅/✅/✅ | ✅/✅/✅ |
| Claude | ✅/✅/✅ | ✅/✅/✅ | ✅/✅/✅ |

Legend per cell: `workspace` / `--add-dir` / `outside`.

### Writes (workspace vs add-dir vs outside)

| Provider | `auto=low` | `auto=medium` | `auto=high` |
|---|---|---|---|
| Codex | ❌/❌/❌ | ✅/✅/❌ | ✅/✅/✅ |
| Claude | ❌/❌/❌ | ✅/✅/❌ | ✅/✅/✅ |

Legend per cell: `workspace` / `--add-dir` / `outside`.

### Local HTTP + WebSearch

| Provider | `auto=low` | `auto=medium` | `auto=high` |
|---|---|---|---|
| Codex | curl ❌, WebSearch ✅ | curl ✅, WebSearch ✅ | curl ✅, WebSearch ✅ |
| Claude | curl ❌, WebSearch ✅ | curl ✅, WebSearch ✅ | curl ✅, WebSearch ✅ |

Notes:
- Codex `auto=low` used `sandboxMode="read-only"` and `curl` to local HTTP failed in this environment.
- Claude `auto=low` denies network-capable `Bash` commands (like `curl`) for portability with Codex `auto=low`.
