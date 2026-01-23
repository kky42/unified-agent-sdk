# Access

This SDK exposes a small, provider-agnostic access surface via `SessionConfig.access`:

```ts
type AccessConfig = {
  auto?: "low" | "medium" | "high";
};
```

These flags are **mapped by each provider adapter** into that provider’s sandbox/permission mechanisms.

Source of truth:
- Codex mapping: `packages/provider-codex/src/index.ts` (`mapUnifiedAccessToCodex`)
- Claude mapping: `packages/provider-claude/src/index.ts` (`mapUnifiedAccessToClaude`)

## Unified intent

- `auto="low"`: read-only + WebSearch (if supported). For portability, do not rely on shell network tools (for example `curl`); use `auto="medium"` for HTTP/local APIs.
- `auto="medium"`: sandboxed writes (workspace-write) + WebSearch + network (including local URLs / local HTTP APIs).
- `auto="high"`: unrestricted / bypass (use with caution).

## Provider mapping

### Codex

Codex enforcement is primarily driven by `ThreadOptions.sandboxMode` + `ThreadOptions.approvalPolicy`.

The Codex adapter sets:
- `approvalPolicy = "never"` (no interactive approvals)
- `sandboxMode` from `access.auto`:
  - `low` → `"read-only"`
  - `medium` → `"workspace-write"`
  - `high` → `"danger-full-access"`
- `networkAccessEnabled = true`
- `webSearchEnabled = true`

Notes:
- Network behavior can still be affected by Codex CLI/environment configuration (for example `CODEX_SANDBOX_NETWORK_DISABLED=1`).
- On current Codex CLI builds, `sandboxMode="read-only"` (`auto="low"`) may block shell network tools like `curl`; use `auto="medium"` for local HTTP APIs if you need `curl`.

### Claude

Claude enforcement combines:
- Claude Code permission mode (`permissionMode`)
- tool allow/deny (adapter uses `disallowedTools`)
- programmatic permission gate (`canUseTool`) for non-interactive runs
- optional Claude sandbox settings (`Options.sandbox`)

The Claude adapter maps:
- `auto="high"` → `permissionMode="bypassPermissions"` + `allowDangerouslySkipPermissions=true` + `sandbox.enabled=false` + no `canUseTool`
- `auto="medium"` → `permissionMode="default"` + `sandbox.enabled=true` + `sandbox.allowUnsandboxedCommands=false` + `canUseTool` gate
- `auto="low"` → `permissionMode="default"` + `sandbox.enabled=false` + `canUseTool` gate (read-only)

Notes:
- Claude Code sandbox networking is allow-list driven. In `auto="medium"`, this repo’s adapter configures `sandbox.network.allowedDomains` and includes `localhost` / `127.0.0.1` / `::1` so local HTTP APIs work.
- For consistency with Codex `auto="low"` behavior, this repo’s adapter denies network-capable `Bash` commands in `auto="low"` (for example `curl`, `wget`, `ssh`).
