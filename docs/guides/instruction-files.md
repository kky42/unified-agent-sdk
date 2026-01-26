# Instruction File Discovery (Codex vs Claude)

This guide explains how instruction files are discovered so you can configure workspaces that behave the same across providers.

## Quick comparison

| Provider | Instruction files | Search scope | Order / precedence | Override mechanism |
|---|---|---|---|---|
| Codex | `AGENTS.md`, `AGENTS.override.md` | **Git root → workspace cwd** only (plus `CODEX_HOME`) | `CODEX_HOME` first, then each directory on the path from git root to cwd | `AGENTS.override.md` replaces `AGENTS.md` in the same directory |
| Claude | `CLAUDE.md` | **cwd and all ancestor directories** (can be above git root), plus `CLAUDE_CONFIG_DIR` | `CLAUDE_CONFIG_DIR` first, then ancestor chain from cwd upward | No dedicated override file; use a nearer `CLAUDE.md` to restate or supersede |

## File naming conventions

- Codex: `AGENTS.md` and optional `AGENTS.override.md`.
- Claude: `CLAUDE.md`.
- Optional/experimental: Claude also has `CLAUDE.local.md`, but it was **not** loaded in our discovery test (see troubleshooting).

## Codex discovery details

Observed behavior via `uagent codex exec` (see `docs/specs/instruction-discovery.md`):

1) Loads exactly one “global” file from `CODEX_HOME`:
   - prefers `AGENTS.override.md` over `AGENTS.md`.
2) Finds the git root for the workspace and walks **git root → workspace cwd**.
3) In each directory on that path, loads at most one instruction file:
   - prefers `AGENTS.override.md` over `AGENTS.md`.
4) Does **not** load `AGENTS*` from directories above git root.
5) Does **not** load `AGENTS*` from sibling directories not on the root→cwd path.

### Override behavior (Codex)

- Drop an `AGENTS.override.md` in any directory to replace the `AGENTS.md` in that same directory.
- If both `CODEX_HOME/AGENTS.override.md` and `CODEX_HOME/AGENTS.md` exist, only the override is used.

## Claude discovery details

Observed behavior via `uagent claude exec` (see `docs/specs/instruction-discovery.md`):

1) Loads a “global” `CLAUDE.md` from `CLAUDE_CONFIG_DIR` (the `uagent --home` directory).
2) Loads **all** `CLAUDE.md` files from the **workspace cwd** and its **parent directories**.
   - This includes `CLAUDE.md` files located *above* the git root.
3) Does **not** load `CLAUDE.md` from sibling directories not on the ancestor chain.

### Override behavior (Claude)

Claude merges multiple `CLAUDE.md` files; there is no dedicated override file. To change behavior:

- Add a `CLAUDE.md` closer to `workspace.cwd` to restate or supersede instructions.
- Remove or edit parent `CLAUDE.md` files if you do not want them applied.

## Workspace setup example (works for both providers)

```text
my-workspace
├── AGENTS.md
├── CLAUDE.md
├── repo
│   ├── AGENTS.md
│   ├── CLAUDE.md
│   └── src
│       └── ...
```

Recommendations:
- Put **both** `AGENTS.md` and `CLAUDE.md` at the workspace root (or repo root) so both providers see them.
- If you want directory-specific instructions, add **another** `AGENTS.md` / `CLAUDE.md` inside that subtree.
- For Codex, consider `AGENTS.override.md` in a subdirectory to replace that directory’s `AGENTS.md` without removing it.

## Troubleshooting

- Claude sees instructions above your repo root, Codex does not:
  - Codex only searches **git root → cwd**. Claude walks **cwd → filesystem root**.
  - Ensure both `AGENTS.md` and `CLAUDE.md` exist within the repo path you want applied.
- Claude doesn’t load `CLAUDE.md`:
  - Ensure `settingSources` includes `"project"` (required to load project settings and `CLAUDE.md`).
  - Ensure `workspace.cwd` points to the directory that contains your `CLAUDE.md`.
- Codex ignores your instructions:
  - Check for an `AGENTS.override.md` in the same directory (it replaces `AGENTS.md`).
  - Ensure the repo has a git root; Codex discovery is rooted at git root.
- `CLAUDE.local.md` not applied:
  - In our discovery test, `CLAUDE.local.md` was **not** loaded; treat it as experimental and verify in your environment.

For the raw discovery experiments, see `docs/specs/instruction-discovery.md`.
