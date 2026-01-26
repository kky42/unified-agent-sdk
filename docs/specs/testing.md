# Testing

This repo supports three practical validation modes: **unit**, **smoke**, and **integration**. Start with typecheck.

One important behavioral note:
- `UnifiedSession.run()` starts immediately. `RunHandle.result` will settle even if you never iterate `RunHandle.events`.
- If you want streaming output / detailed telemetry, iterate `RunHandle.events` promptly; the event stream is buffered with an internal cap and may drop events if not consumed.

## At a glance

| Level | What it validates | Real execution? | Command |
|---|---|---:|---|
| 0 | Type safety across packages | No | `npm run typecheck` |
| 1 | Adapter behavior with fakes (event mapping, cancellation) | No | `npm run test:unittest` |
| 2 | Smoke tests (real SDK + real CLI) | Yes (local) | `npm run test:smoke` |
| 3 | Integration tests (real SDK + real API calls) | Yes (network/cost) | `npm run test:integration` |

## Unit tests (default)

`npm test` runs the Node test runner over `test/unittest/**/*.test.js` only.

```sh
npm test
```

## Smoke tests (real execution)

Smoke tests run the real SDKs/CLIs and make real API calls. Run them locally to verify your environment (auth, CLI, sandboxing).

### Provider dependencies

Provider SDKs are regular dependencies now. A repo-root `npm install` will pull them in for the workspace packages.

```sh
npm run test:smoke
```

Smoke tests use your local CLI auth state (by default `~/.claude` and `~/.codex`). Ensure you are logged in for both providers before running.

## Integration tests (real API; opt-in)

Integration tests rely on local CLI auth state (by default `~/.claude` and `~/.codex`). Ensure you are logged in for both providers before running.

Run:

```sh
npm run test:integration
```

To run a single provider's integration tests, run the file directly (only that provider's auth state is required):

```sh
# Codex only
node --test test/integration/codex.integration.test.js

# Claude only
node --test test/integration/claude.integration.test.js
```

## Provider-specific notes

| Provider | Common CI defaults | Notes |
|---|---|---|
| Codex | `sandboxMode: "read-only"`, `approvalPolicy: "never"`, `skipGitRepoCheck: true` | Set `CODEX_HOME` to a repo-local dir to avoid writing to user home |
| Claude | `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, `DISABLE_ERROR_REPORTING=1` | Structured output may take multiple turns (`maxTurns >= 3`) |

## Manual access testing with `uagent exec`

When changing access/sandbox behavior, validate it end-to-end using `uagent exec` (real providers) in a **temporary directory**.

Note: run the CLI directly from the repo (`node packages/uagent/bin/uagent.js ...`). We no longer use npm `interactive:*` helpers for testing.

Philosophy:
- Use a temp workspace to avoid touching real repos.
- Ask the agent to perform a concrete action **and** to report whether it succeeded and why.
- Then *you* check the filesystem / output to confirm.

### Setup: temporary workspace roots

Create two temp dirs.

Important Codex note:
- Codex commonly treats `/tmp` (and macOS temp locations) as writable roots even without `--add-dir`.
- If you want to verify `--add-dir` / workspace-root write restrictions, use a temp directory **outside** `/tmp` (for example under your project directory) and delete it afterwards.

```sh
# Recommended (works for both providers; avoids Codex's always-writable `/tmp` roots):
BASE="$(mktemp -d "$PWD/.cache/uagent-access-test.XXXXXX")"
WORKSPACE="$BASE/workspace"
OUTSIDE="$BASE/outside"
mkdir -p "$WORKSPACE" "$OUTSIDE"
```

Choose provider + home (examples; adjust paths). The home directory must already exist:

```sh
# Codex
PROVIDER=codex
HOME="$PWD/.profiles/codex/yescode"

# Claude
# PROVIDER=claude
# HOME="$PWD/.profiles/claude/minimax"
```

Common flags (repeat `--add-dir` as needed):

```sh
UA="node packages/uagent/bin/uagent.js $PROVIDER exec --workspace \"$WORKSPACE\" --home \"$HOME\""
```

### Network + WebSearch

Unified `access.auto` presets enable the provider WebSearch tool (when supported). Shell networking (for example `curl`) is intentionally conservative in `auto=low`; use `auto=medium` for HTTP/local APIs.

To validate **local HTTP** (recommended; no internet dependency), start a local server and ask the agent to `curl` it:

```sh
PORT=8123
python3 -m http.server "$PORT" --bind 127.0.0.1

eval "$UA" --auto medium \
  "Use Bash to run: curl -sI http://127.0.0.1:$PORT/ | head -n 1. Tell me the exact output line."
```

To validate **WebSearch** (real provider call; may incur cost), ask it to use the WebSearch tool:

```sh
eval "$UA" --auto low \
  "Use the WebSearch tool to search for: example.com example domain. Tell me whether it succeeded."
```

### `auto=low` (read-only)

1) Attempt to write outside workspace (should fail):

```sh
eval "$UA" --auto low \
  "Write 'hi' to $OUTSIDE/outside.txt. Tell me whether the task succeeded. If it failed, explain why."
```

2) Add outside as a writable root, then retry (should still fail in `auto=low`):

```sh
eval "$UA" --auto low --add-dir "$OUTSIDE" \
  "Write 'hi' to $OUTSIDE/outside.txt. Tell me whether the task succeeded. If it failed, explain why."
```

3) Ask it to run a safe read-only command in the workspace (should succeed):

```sh
printf "hello\n" > "$WORKSPACE/hello.txt"
eval "$UA" --auto low \
  "Use a command to print the first line of $WORKSPACE/hello.txt. Tell me whether it succeeded."
```

Expected:
- Writes fail (even with `--add-dir`) because `auto=low` is read-only.
- Read-only commands succeed.

### `auto=medium` (sandboxed writes/commands)

1) Write outside workspace without `--add-dir` (should fail):

```sh
eval "$UA" --auto medium \
  "Write 'hi' to $OUTSIDE/outside.txt. Tell me whether the task succeeded. If it failed, explain why."
```

2) Add outside as writable root and retry (should succeed):

```sh
eval "$UA" --auto medium --add-dir "$OUTSIDE" \
  "Write 'hi' to $OUTSIDE/outside.txt. Tell me whether the task succeeded. If it failed, explain why."
```

3) Run a command that writes inside the workspace (should succeed):

```sh
eval "$UA" --auto medium \
  "Use a command to create $WORKSPACE/in_workspace.txt with content OK. Tell me whether it succeeded."
```

Expected:
- Writes are restricted to `--workspace` + `--add-dir` roots.

Claude note (sandboxed mode): Claude Code’s sandbox derives write permissions from `Edit(...)` allow rules. This SDK injects `Edit(...)` rules for `--add-dir` automatically in `auto=medium` unless you override settings via `extraArgs.settings`.

### `auto=high` (unrestricted)

Goal: verify it can write outside workspace even without `--add-dir`.

```sh
eval "$UA" --auto high \
  "Write 'hi' to $OUTSIDE/high_outside.txt. Tell me whether the task succeeded. If it failed, explain why."
```

Expected:
- Succeeds (unrestricted). Use with caution.

### Cleanup

```sh
rm -rf "$BASE"
```
