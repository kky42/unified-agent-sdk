# E2E Testing Principles (Real Providers)

These principles are for **end-to-end behavioral testing** of unified-agent-sdk access controls (`workspace`, `additionalDirs`, `auto`) using **real provider SDKs + real provider CLIs**.

This is the most reliable way to answer questions like:
- “Does `auto=low` really prevent writes?”
- “Does `--add-dir` actually become writable?”
- “Can the agent `curl` a local HTTP API on `127.0.0.1` / `localhost`?”
- “Do changes via `snapshot()`/`resumeSession()` actually take effect?”

> E2E tests are not free: they make real API calls (cost), and provider sandboxes differ. Treat results as behavior, not a security boundary.

## Safety first (don’t damage the user’s machine)

- **Never test in a real repo/workspace.** Create a dedicated test root and operate only inside it.
- Prefer a test root **outside `/tmp`** on macOS:
  - Codex sandboxes often treat some temp locations (like `/tmp`) as writable even when they’re outside your configured workspace.
- Verify outcomes **externally**:
  - For filesystem tests, check the filesystem yourself (`ls`, `cat`) instead of trusting the model’s narration.
  - For network tests, record the command output / exit status.

## Use real providers (and always use verbose mode)

E2E means:
- Real providers: Codex + Claude (or whichever adapter you’re validating)
- Real tool calls
- `--verbose` so you can see what tools were attempted

Recommended:
- Add `--trace` when debugging unexpected behavior (events to stderr).

## Orthogonal test design (avoid confounders)

When building a matrix (e.g. `auto × target-path`), keep each axis testable without accidental interactions:

- **Avoid write-ish `curl` flags**:
  - `curl -o ...` looks like “write to a file” and may be denied by your policy even though the network request itself is allowed.
- Avoid pipelines that mask failures:
  - `curl ... | head -n 1` can make failures look like “no output” unless you use `pipefail`.
- Prefer simple commands that produce an unambiguous stdout token for classification.

Example network command that is compatible with `auto=medium` while still signaling failure:

```sh
curl -sI http://127.0.0.1:$PORT/ || echo CURL_FAILED
```

## Iteration policy (keep tests trustworthy)

Sometimes models:
- skip tool calls and “guess”
- use alternative tools (e.g. `WebFetch` instead of `WebSearch`)
- hit transient provider errors (e.g. disconnects, 5xx)

Policy:
- If you can’t classify a result from **one** run, iterate the prompt (max **5** attempts).
- If a run fails due to provider flakiness, rerun the *same* test (count it toward the 5).
- Record when a result needed retries.

## Provider-specific gotchas (practical)

### Codex

- Codex sandbox network can be affected by environment/config (for example `CODEX_SANDBOX_NETWORK_DISABLED=1`).
- On some macOS setups, paths under `/tmp` may be writable even when outside your configured workspace.

### Claude

- In `auto=medium`, Claude Code sandboxing can block behaviors even when unified policy allows them:
  - writes to `workspace.additionalDirs` require `Edit(...)` allow rules; this SDK injects them by default (unless you override settings via `extraArgs.settings`)
  - sandbox networking is allow-list driven; ensure the target host is permitted (this repo’s adapter includes `localhost` / `127.0.0.1` / `::1` so local HTTP APIs work)
- In this environment, resuming a session with a different `workspace.cwd` failed (Claude Code exited with “check workspace.cwd exists” even when it does). Treat `cwd` changes as “start a new session”.

## In-flight reconfiguration (snapshot/resume)

Unified sessions are immutable. To change settings mid-session:

1. `snapshot()` → `SessionHandle`
2. mutate `handle.metadata.unifiedAgentSdk.sessionConfig`
3. `resumeSession(handle)` → new session with the same provider-native `sessionId`

### Using `uagent`

`uagent` supports this workflow:

```sh
# Start a session and persist a handle
node packages/uagent/bin/uagent.js codex exec --verbose --dump-handle /path/to/handle.json "..."

# Resume with different settings
node packages/uagent/bin/uagent.js codex resume --handle /path/to/handle.json --auto high --verbose "..."
```

Validation pattern (recommended):
- Prove history is preserved (ask the model to recall a non-sensitive fact from earlier)
- Prove session is preserved (`uagent` prints `sessionId=...` to stderr)
- Prove policy changed (an action denied before becomes allowed after, or vice versa)

## Recording results

For every e2e test report, include:
- date
- provider SDK versions
- model + reasoning effort
- test workspace paths
- the exact matrix you ran and the classification rule you used
- any retries / flaky behavior

See also: `docs/experiments/2026-01-23-permission-e2e-testing.md` (current point-in-time results).
