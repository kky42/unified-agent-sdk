# Interactive runner

Use `uagent` (in `packages/uagent`) to chat with the SDK in an interactive TUI while it streams `RuntimeEvent`s.

## Run

Build + start an interactive session (Codex by default):

```sh
npm run interactive
```

Provider auth is still done via environment variables:
- Codex: `CODEX_API_KEY` (or `OPENAI_API_KEY`)
- Claude: `ANTHROPIC_API_KEY` (or `ANTHROPIC_AUTH_TOKEN`)

## Provider choice

Run specific providers:

```sh
npm run interactive:codex
npm run interactive:claude
```

## Workspace and home

These scripts set:
- `--workspace .` (repo root)
- `--home .cache/uagent/<provider>` (provider config + session state under the repo)

## Commands

While running, type `/exit` to quit.

## Examples

Allow network (still no writes):

```sh
node packages/uagent/bin/uagent.js codex --workspace . --home .cache/uagent/codex --network
```

Run with full autonomy (network + writes, sandbox off):

```sh
node packages/uagent/bin/uagent.js claude --workspace . --home .cache/uagent/claude --yolo
```
