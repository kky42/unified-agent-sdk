# Access

This SDK exposes a small, provider-agnostic access surface via `SessionConfig.access`:

```ts
type AccessConfig = {
  auto?: "low" | "medium" | "high";
  network?: boolean; // default true
  webSearch?: boolean; // default true
};
```

These flags are **mapped by each provider adapter** into that provider’s sandbox/approval/permission mechanisms.

Source of truth:
- Codex mapping: `packages/provider-codex/src/index.ts` (`mapUnifiedAccessToCodex`)
- Claude mapping: `packages/provider-claude/src/index.ts` (`mapUnifiedAccessToClaude`)

## Unified intent

- `auto="low"`: read-only (no file edits; limited bash).
- `auto="medium"`: allow edits + commands, but keep execution sandboxed where the provider supports it.
- `auto="high"`: highest permission level with no restraints (use with caution).
- `network=false`: disable network-capable operations where supported (for example WebFetch; networky bash commands).
- `webSearch=false`: disable the provider web search tool.

Note: `auto="high"` is intended to mean “no restraints”; provider adapters may treat `network`/`webSearch` as effectively enabled in this mode.

## Codex

Codex enforcement is primarily driven by `ThreadOptions.sandboxMode` + `ThreadOptions.approvalPolicy`.

### Mapping (unified → Codex)

The Codex adapter sets:
- `approvalPolicy = "never"` (no interactive approvals)
- `networkAccessEnabled = access.network`
- `webSearchEnabled = access.webSearch`
- `sandboxMode` from `access.auto`:
  - `low` → `"read-only"`
  - `medium` → `"workspace-write"`
  - `high` → `"danger-full-access"`

Notes:
- Codex sandbox modes mostly constrain **writes/execution scope**; read-only inspection may still read broadly depending on Codex CLI behavior.
- In `auto="high"`, the Codex adapter enables network + web search regardless of `access.network` / `access.webSearch` (to match “no restraints” intent).

## Claude

Claude enforcement combines:
- Claude Code permission mode (`permissionMode`)
- tool allow/deny (adapter uses `disallowedTools`)
- programmatic permission gate (`canUseTool`) when non-interactive
- optional Claude sandbox settings (`Options.sandbox`, injected via CLI `--settings`)

### Mapping (unified → Claude)

The Claude adapter maps:
- `auto="high"` → `permissionMode="bypassPermissions"` + `allowDangerouslySkipPermissions=true` + `sandbox.enabled=false` + no `canUseTool`
- `auto="medium"` → `permissionMode="default"` + `sandbox.enabled=true` + `sandbox.allowUnsandboxedCommands=false` + `canUseTool` gate
- `auto="low"` → `permissionMode="default"` + `sandbox.enabled=false` + `canUseTool` gate (read-only)

In `auto="low"`, `canUseTool` allows a conservative set of read-only commands; when `network=true` it also allows `curl`/`wget` in “stdout-only” mode (blocks output-to-file flags).

Notes:
- Claude’s “sandbox” does not behave exactly like Codex’s sandbox modes; workspace scoping is implemented via permission gating and provider behavior.
- In the Claude adapter, `network=false` removes `WebFetch` and also blocks network-ish `Bash` commands.
- `webSearch=false` removes `WebSearch`.
