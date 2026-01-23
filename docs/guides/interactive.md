# Interactive runner

Use `uagent` (in `packages/uagent`) to chat with the SDK in an interactive TUI while it streams `RuntimeEvent`s.

## Run

Build, then start an interactive session directly from the repo:

```sh
npm run build
node packages/uagent/bin/uagent.js codex --workspace . --home ~/.codex
```

Provider auth is still done via environment variables:
- Codex: `CODEX_API_KEY` (or `OPENAI_API_KEY`)
- Claude: `ANTHROPIC_API_KEY` (or `ANTHROPIC_AUTH_TOKEN`)

## Provider choice

Run a specific provider by switching the first positional arg:

```sh
node packages/uagent/bin/uagent.js codex --workspace . --home ~/.codex
node packages/uagent/bin/uagent.js claude --workspace . --home ~/.claude
```

## Workspace and home

Pass the workspace root (defaults to `cwd`) and a provider home directory:
- `--workspace .` (repo root)
- `--home ~/.codex` or `--home ~/.claude` (provider config + session state)
  - The home directory must already exist; `uagent` will not create it.

You can also include additional workspace roots (repeat the flag):

```sh
node packages/uagent/bin/uagent.js codex --workspace . --home ~/.codex --add-dir ../shared --add-dir /tmp --auto medium
```

## Commands

While running, type `/exit` to quit.

## Examples

Read-only sandbox with WebSearch (shell networking like `curl` may be blocked):

```sh
node packages/uagent/bin/uagent.js codex --workspace . --home ~/.codex --auto low
```

Run with full autonomy (no sandbox / no restrictions):

```sh
node packages/uagent/bin/uagent.js claude --workspace . --home ~/.claude --auto high
```
