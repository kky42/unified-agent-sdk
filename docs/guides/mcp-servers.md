# MCP Server Configuration (Claude vs Codex)

This guide explains how to configure MCP (Model Context Protocol) servers for each provider and how those tools show up in the unified runtime event stream.

## Quick comparison

| Provider | Programmatic config | File-based config | Notes |
|---|---|---|---|
| Claude | `mcpServers` in `createRuntime()` or session `Options` | `.mcp.json` (project) + `~/.claude.json` (local/user) | Programmatic is simplest; file-based is useful for shared tooling. |
| Codex | *(not supported)* | `CODEX_HOME/config.toml` or `codex mcp ...` | Must be configured via Codex config; use per-agent `CODEX_HOME` for isolation. |

## Claude: configure MCP servers in code

When using `@unified-agent-sdk/provider-claude`, configure MCP servers via `mcpServers` either at runtime creation or per session:

```ts
import { createRuntime } from "@unified-agent-sdk/runtime";

const runtime = createRuntime({
  provider: "@unified-agent-sdk/provider-claude",
  defaults: {
    // Claude Options
    mcpServers: {
      localEcho: {
        command: "node",
        args: ["/path/to/echo-mcp.js"],
      },
      docs: {
        url: "https://example.com/mcp",
      },
    },
  },
});
```

Notes:
- `mcpServers` is a Claude SDK option; it is not a unified config field.
- If you set it per-session, it overrides/augments runtime defaults for that session.

## Claude: configure MCP servers via files (`.mcp.json` and `~/.claude.json`)

Claude Code also loads MCP servers from file-based configuration and scope-specific settings. Scopes determine where the config is stored and who can see it:
- **Local scope (default)**: stored in `~/.claude.json` under your project’s path; private to you and only active in the current project.
- **Project scope**: stored in a `.mcp.json` file at the project root (intended for version control).
- **User scope**: stored in `~/.claude.json` and available across all projects.
- **Managed**: stored in `managed-mcp.json` for enterprise control.

Precedence when names conflict is **local > project > user**. Managed policies can restrict which servers are allowed.

Note: local-scoped MCP servers are stored in `~/.claude.json` and are different from general local settings stored in `.claude/settings.local.json`.

You can manage these with the Claude CLI:

```bash
# Local (default)
claude mcp add stripe https://mcp.stripe.com

# Project-scoped (.mcp.json)
claude mcp add --scope project shared-tools /path/to/server

# User-scoped (all projects)
claude mcp add --scope user hubspot https://mcp.hubspot.com/anthropic

# List/get/remove
claude mcp list
claude mcp get shared-tools
claude mcp remove shared-tools

# Add an HTTP server with headers
claude mcp add --transport http corridor https://app.corridor.dev/api/mcp --header "Authorization: Bearer ..."

# Add a stdio server with env vars
claude mcp add --transport stdio --env API_KEY=xxx my-server -- npx my-mcp-server

# Add via JSON (stdio or HTTP)
claude mcp add-json my-server '{"type":"stdio","command":"node","args":["/path/to/server.js"]}'

# Import from Claude Desktop (Mac/WSL)
claude mcp add-from-claude-desktop

# Reset project-scoped approval decisions
claude mcp reset-project-choices

# Run Claude Code as an MCP server
claude mcp serve
```

Project-scoped servers are loaded from `.mcp.json` and may prompt for approval the first time they are used. If you need to reset those approval choices, use `claude mcp reset-project-choices`.

### `.mcp.json` schema (Claude Code)

Project scope uses a standardized JSON structure under `mcpServers`:

```json
{
  "mcpServers": {
    "shared-server": {
      "command": "/path/to/server",
      "args": [],
      "env": {}
    }
  }
}
```

HTTP servers use `type: "http"` with `url` and optional `headers`:

```json
{
  "mcpServers": {
    "api-server": {
      "type": "http",
      "url": "https://api.example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${API_KEY}"
      }
    }
  }
}
```

Claude Code supports environment variable expansion inside `.mcp.json` (for example `${VAR}` or `${VAR:-default}`) in `command`, `args`, `env`, `url`, and `headers`.

Note: Claude Code also supports SSE (`type: "sse"` / `--transport sse`), but it is deprecated in favor of HTTP.

### Claude CLI overrides (session-only)

For one-off sessions, the Claude CLI can load MCP servers directly:

```bash
# Load MCP servers from JSON files or inline JSON
claude --mcp-config /path/to/.mcp.json

# Restrict to only the MCP servers specified in --mcp-config
claude --strict-mcp-config --mcp-config /path/to/.mcp.json
```

Notes:
- The `--scope` flag accepts `local` (default), `project` (writes `.mcp.json`), and `user` (global in `~/.claude.json`).
- All `claude mcp add` options (`--transport`, `--env`, `--scope`, `--header`) must come before the server name.
- Use `/mcp` inside the Claude Code TUI to check status and authenticate OAuth servers.

### Claude CLI: add/list/get/remove (deep reference)

Common CLI patterns:

```bash
# Add an HTTP server
claude mcp add --transport http sentry https://mcp.sentry.dev/mcp

# Add an SSE server (deprecated; HTTP preferred)
claude mcp add --transport sse asana https://mcp.asana.com/sse

# Add an HTTP server with headers
claude mcp add --transport http corridor https://app.corridor.dev/api/mcp --header "Authorization: Bearer ..."

# Add a project-scoped server
claude mcp add --transport http --scope project paypal https://mcp.paypal.com/mcp

# Add a stdio server with env vars
claude mcp add --transport stdio --env API_KEY=xxx my-server -- npx my-mcp-server

# Add via JSON (stdio or HTTP)
claude mcp add-json my-server '{"type":"stdio","command":"node","args":["/path/to/server.js"]}'

# List/get/remove
claude mcp list
claude mcp get my-server
claude mcp remove my-server

# Import from Claude Desktop (Mac/WSL)
claude mcp add-from-claude-desktop

# Reset project-scoped approval decisions
claude mcp reset-project-choices

# Run Claude Code as an MCP server
claude mcp serve
```

## Codex: configure MCP servers via CODEX_HOME

Codex does not accept MCP configuration via runtime/session options. You must configure MCP servers through Codex config files (or the Codex CLI), which live under `CODEX_HOME` (default: `~/.codex`). The Codex CLI and IDE extension share this config.

### Option A: `codex mcp` CLI

Use the Codex CLI to create entries under `CODEX_HOME/config.toml`:

```bash
# Use a per-agent home for isolation
export CODEX_HOME=/path/to/agent-home

# Add a streamable HTTP MCP server
codex mcp add docs --url http://127.0.0.1:4000/mcp

# Add a streamable HTTP MCP server with bearer token
codex mcp add docs-auth --url https://api.example.com/mcp --bearer-token-env-var API_TOKEN

# Add a stdio MCP server
codex mcp add local-stdio -- node /path/to/server.js --transport stdio

# List configured MCP servers
codex mcp list --json

# Get a single MCP server
codex mcp get docs --json

# Remove an MCP server
codex mcp remove docs

# OAuth login/logout for HTTP servers (if supported by the server)
codex mcp login docs
codex mcp logout docs
```

### Option B: edit `config.toml` directly

Codex reads MCP server entries from `CODEX_HOME/config.toml` under `mcp_servers`:

```toml
[mcp_servers.local_stdio]
command = "node"
args = ["/path/to/server.js", "--transport", "stdio"]
env = { "FOO" = "bar" }

[mcp_servers.local_http]
url = "http://127.0.0.1:4000/mcp"

startup_timeout_sec = 20
tool_timeout_sec = 30
```

Supported server types (observed via `codex mcp list`):
- **stdio**: `command`, optional `args`, optional `env`
- **streamable_http**: `url`

Additional `config.toml` options (Codex MCP):
- `env_vars` (stdio): allowlist of environment variables to pass through
- `cwd` (stdio): working directory to start the server from
- `bearer_token_env_var` (HTTP): env var whose value becomes `Authorization: Bearer ...`
- `http_headers` / `env_http_headers` (HTTP): static or env-sourced headers
- `startup_timeout_sec`, `tool_timeout_sec` (timeouts; defaults are 10s and 60s)
- `enabled`, `enabled_tools`, `disabled_tools` (server/tool allow/deny)
- `mcp_oauth_callback_port` (top-level): fixed OAuth callback port

Notes:
- OAuth login/logout is only supported for streamable HTTP servers (and only if the server supports OAuth).
- Use `/mcp` in the Codex CLI TUI to view active servers and authenticate.

### Programmatic configuration (Codex)

Codex does not expose MCP configuration via the runtime/session API. To manage MCP servers per agent, use one of the file-based approaches above and pass a distinct `home` (i.e., `CODEX_HOME`) when creating each Codex runtime.

### Per-agent configuration strategy

If you need different MCP tools per agent, create **one Codex runtime per agent** with a distinct `CODEX_HOME`:

```ts
import { createRuntime } from "@unified-agent-sdk/runtime";

const runtime = createRuntime({
  provider: "@openai/codex-sdk",
  home: "/path/to/agent-home", // CODEX_HOME for this agent
});
```

Then set up that directory’s `config.toml` (or run `codex mcp add` with `CODEX_HOME` set).

## MCP tool naming conventions

MCP tools appear as `server.tool` in the unified runtime:
- Example: an MCP server named `docs` with tool `search` appears as `docs.search`.

## MCP events in the runtime stream

In the unified `RuntimeEvent` stream:

- MCP calls are surfaced as `tool.call` events.
- The `toolName` is `server.tool`.
- Provider-specific events map into `mcp_tool_call` items (see `docs/guides/events.md`).

## Troubleshooting

- **Codex MCP tools not found**:
  - Ensure `CODEX_HOME` points to the directory that contains `config.toml`.
  - Run `codex mcp list --json` with the same `CODEX_HOME` to confirm the server is registered.
- **Claude MCP tools missing**:
  - Ensure `mcpServers` is passed via runtime defaults or session options.
- **Conflicting tool names**:
  - Rename the MCP server (the `mcp_servers.<name>` key) to avoid collisions.
- **Per-agent isolation not working (Codex)**:
  - Verify each agent uses a distinct `CODEX_HOME` and its own `config.toml`.
