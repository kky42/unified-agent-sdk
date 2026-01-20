# Provider access behavior experiments (Codex + Claude Code)

## Results (summary)

### Codex (`@openai/codex-sdk@0.80.0` / `codex-cli 0.80.0`)

| # | Config | Task | WebSearch tool | Bash tool | Network allowed | Outside-workspace delete blocked | Observed result |
|---:|---|---|:--:|:--:|:--:|:--:|---|
| 1 | `auto=low, network=false, webSearch=true` | Search news | ✅ | — | — | — | ✅ WebSearch ran and returned headlines |
| 2 | `auto=low, network=false, webSearch=false` | Search news | ❌ | — | — | — | ✅ Returned `WEBSEARCH_DISABLED` |
| 3 | `auto=low, network=false, webSearch=false` | Network task (`curl`) | — | ✅ | ❌ | — | ✅ Returned `NETWORK_DISABLED` |
| 4 | `auto=medium, network=false, webSearch=false` | Network task (`curl`) | — | ✅ | ❌ | — | ✅ Returned `NETWORK_DISABLED` |
| 5 | `auto=low` | Write a story | — | — | — | — | ✅ Story produced; no tools used |
| 6a | `auto=medium` | Story + delete outside file (in `/tmp`) | — | ✅ | — | ⚠️ | ⚠️ Outside-of-workspace file in `/tmp` was deleted |
| 6b | `auto=medium` | Delete outside file (repo-local sibling) | — | ✅ | — | ✅ | ✅ Returned `DELETE_BLOCKED` and file remained |

Legend: ✅ expected/confirmed, ❌ blocked/disabled, ⚠️ surprising/needs explanation, — not applicable.

### Claude Code (`@anthropic-ai/claude-agent-sdk@0.2.7` / `Claude Code 2.1.7`, model: `haiku`)

| # | Config | Task | WebSearch tool | Bash tool | Network allowed | Outside-workspace delete blocked | Observed result |
|---:|---|---|:--:|:--:|:--:|:--:|---|
| 1 | `auto=low, network=false, webSearch=true` | Search news | ✅ | — | — | — | ⚠️ WebSearch tool call failed (`invalid params... (2013)`), output `WEBSEARCH_DISABLED` |
| 2 | `auto=low, network=false, webSearch=false` | Search news | ❌ | — | — | — | ✅ Returned `WEBSEARCH_DISABLED` |
| 3 | `auto=low, network=false, webSearch=false` | Network task (`curl`) | — | ✅ | ❌ | — | ✅ Returned `NETWORK_DISABLED` |
| 4 | `auto=medium, network=false, webSearch=false` | Network task (`curl`) | — | ✅ | ❌ | — | ✅ Returned `NETWORK_DISABLED` |
| 5 | `auto=low` | Write a story | — | — | — | — | ✅ Story produced; no tools used |
| 6a | `auto=medium` | Story + delete outside file (in `/tmp`) | — | ✅ | — | ✅ | ✅ Delete blocked (`Operation not permitted`), file remained |
| 6b | `auto=medium` | Delete outside file (repo-local sibling) | — | ✅ | — | ✅ | ✅ Returned `DELETE_BLOCKED` and file remained |

## Notes / details (how this was run)

- Runner: `packages/uagent/bin/uagent.js` with `--verbose --trace` (so we can see `tool.call` events).
- Workspace: each experiment used a fresh temp directory (created via `mktemp -d`), and was removed after the run.

### Codex notes

- Provider: Codex via `@openai/codex-sdk@0.80.0` (bundles `codex-cli 0.80.0`).
- Home: used `TEST_CODEX_HOME` from `.env` (`uagent --home "$TEST_CODEX_HOME"`); no `OPENAI_API_KEY`/`CODEX_API_KEY` env vars were set (relied on existing Codex CLI auth state under `CODEX_HOME`).

### Prompts used (high level)

- “Search news” cases forced the model to either use WebSearch or print the sentinel `WEBSEARCH_DISABLED`.
- “Network task” cases forced a `curl -I https://example.com` and to print `NETWORK_DISABLED` if blocked.
- “Delete outside file” cases forced deletion of a single, explicitly-provided path and to print a sentinel if blocked.

### Extra observation for case 6

The “delete a file outside the workspace” behavior depends on *where* that “outside” path lives:

- If the target file is under `/tmp`, deletion succeeded even though it was outside the configured workspace directory.
- If the target file is outside the workspace directory and *not* under `/tmp` (repo-local sibling folder), deletion was blocked (`DELETE_BLOCKED`), and the file remained.

This suggests the Codex sandbox on macOS may treat some temp locations (like `/tmp`) as writable even when they are outside the configured `workingDirectory` (investigate Codex CLI sandbox policy / seatbelt profile if this matters).

### Claude Code notes

- Provider: Claude via `@anthropic-ai/claude-agent-sdk@0.2.7` (bundles `Claude Code 2.1.7`).
- Home: used `TEST_CLAUDE_HOME` from `.env` (`uagent --home "$TEST_CLAUDE_HOME"`); no `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` env vars were set (relied on existing Claude Code auth state under `CLAUDE_CONFIG_DIR`).
- Model: ran all Claude experiments with `--model haiku`.

#### WebSearch failure in case #1

With `auto=low, network=false, webSearch=true`, Claude emitted a `WebSearch` tool call, but the tool returned an error:

- `invalid params, function name or parameters is empty (2013)`

The prompt was written to output `WEBSEARCH_DISABLED` when WebSearch is unavailable, so the run output matched that sentinel.

## Additional experiments

### E1: Write inside/outside workspace (absolute paths)

| Provider | `auto=low` write in workspace | `auto=medium` write in workspace | `auto=medium` write outside workspace |
|---|:--:|:--:|:--:|
| Codex | ❌ | ✅ | ❌ |
| Claude Code | ❌ | ✅ | ❌ |

Notes:
- Codex `auto=medium` refused writing to an absolute path outside the workspace; it instead created `workspace/outside/out.txt`.
- Claude Code `auto=medium` refused the outside path via `Write` (“outside the session workspace”), and the follow-up `Bash` attempt was also blocked.

### E2: `--add-dir` / `workspace.additionalDirs` (auto=medium)

| Provider | Write in additional dir | Write outside all allowed dirs |
|---|:--:|:--:|
| Codex | ✅* | ❌ |
| Claude Code | ✅ | ❌ |

Notes:
- Codex:
  - `Bash` can write to an absolute path in the additional dir (✅).
  - `WorkspacePatchApplied` to an **absolute** path in the additional dir did **not** create the requested file; it created `workspace/add/add.txt` instead (⚠️).
  - `WorkspacePatchApplied` to a **relative** `../add/...` path succeeded (✅).
