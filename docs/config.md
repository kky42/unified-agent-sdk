# Configuration

This SDK splits configuration into:
- **Unified config** (portable): owned by `@unified-agent-sdk/runtime-core`
- **Provider config** (provider-specific): owned by each provider adapter package

The orchestrator should generally depend on the unified interfaces (`UnifiedAgentRuntime` / `UnifiedSession`) and only decide *which provider runtime to construct* at the composition root.

## Quick comparison (Claude vs Codex)

| Concern | Claude (`@unified-agent-sdk/provider-claude`) | Codex (`@unified-agent-sdk/provider-codex`) |
|---|---|---|
| Runtime config type | `ClaudeRuntimeConfig` | `CodexRuntimeConfig` |
| Session provider type (`SessionConfig.provider`) | `ClaudeSessionConfig` | `CodexSessionConfig` = `Omit<ThreadOptions, "workingDirectory" \| "additionalDirectories" \| "model" \| "modelReasoningEffort">` |
| Run provider type (`RunConfig.provider`) | `Partial<ClaudeSessionConfig>` (merged into options) | `never` (not supported) |
| Workspace `cwd` mapping | `Options.cwd` | `ThreadOptions.workingDirectory` |
| Workspace `additionalDirs` mapping | `Options.additionalDirectories` | `ThreadOptions.additionalDirectories` |
| Claude Code settings files | `settingSources` defaults to `["user","project"]` when omitted | *(n/a)* |
| Codex git repo check | *(n/a)* | `createRuntime()` defaults `skipGitRepoCheck=true` |
| Access (portable) | `SessionConfig.access` (mapped) | `SessionConfig.access` (mapped) |
| Reasoning effort (portable) | `SessionConfig.reasoningEffort` (mapped) | `SessionConfig.reasoningEffort` (mapped) |
| Structured output (`RunConfig.outputSchema`) | `Options.outputFormat = { type: "json_schema", schema }` | forwarded as `turnOptions.outputSchema` |
| Cancellation (`RunConfig.signal`) | mirrored into Claude `abortController` | mirrored into `turnOptions.signal` |
| Resume support | `resumeSession(handle.nativeSessionId)` | `resumeSession(handle.nativeSessionId)` |

## Unified config reference (portable)

All unified config types are defined in `packages/runtime-core/src/index.ts`.

| Type | Purpose | Key fields |
|---|---|---|
| `WorkspaceConfig` | Filesystem / workspace scope for a session | `cwd`, `additionalDirs?` |
| `SessionConfig<TProvider = ProviderConfig>` | Per-session config | `workspace?`, `model?`, `reasoningEffort?`, `access?`, `provider?` |
| `RunConfig<TRunProvider = ProviderConfig>` | Per-run config | `outputSchema?`, `signal?`, `provider?` |
| `RunRequest<TRunProvider = ProviderConfig>` | Run invocation payload | `input`, `config?` |

## Unified access config (portable)

`SessionConfig.access` provides a small, provider-agnostic control surface:

| Field | Meaning |
|---|---|
| `access.auto` | Access preset: `low` (read-only), `medium` (sandboxed writes/commands), `high` (unrestricted) |
| `access.network` | Allow outbound network access (provider-dependent) |
| `access.webSearch` | Allow the provider web search tool (provider-dependent) |

Defaults (when omitted): `auto="medium"`, `network=true`, `webSearch=true`.

Note: `auto="high"` is intended to mean “no restraints”; provider adapters may treat `network`/`webSearch` as effectively enabled in this mode.

## Unified reasoning config (portable)

`SessionConfig.reasoningEffort` provides a small, provider-agnostic control surface for “how much reasoning / thinking budget” the model should use.

Supported values: `none`, `low`, `medium`, `high`, `xhigh`.

Defaults (when omitted): `reasoningEffort="medium"`.

Provider mapping:

| Unified | Claude (`@anthropic-ai/claude-agent-sdk`) | Codex (`@openai/codex-sdk`) |
|---|---|---|
| `none` | `maxThinkingTokens = 0` | `modelReasoningEffort = "minimal"` |
| `low` | `maxThinkingTokens = 4000` | `modelReasoningEffort = "low"` |
| `medium` | `maxThinkingTokens = 8000` | `modelReasoningEffort = "medium"` |
| `high` | `maxThinkingTokens = 12000` | `modelReasoningEffort = "high"` |
| `xhigh` | `maxThinkingTokens = 16000` | `modelReasoningEffort = "xhigh"` |

## How layers compose (what gets applied where)

| Layer | Unified field | Claude adapter behavior | Codex adapter behavior |
|---|---|---|---|
| Runtime defaults | *(provider-specific)* | `ClaudeRuntimeConfig.defaults` applied to every `query()` | `CodexRuntimeConfig.defaults` applied to every thread |
| Session access | `SessionConfig.access` | maps to Claude permission mode + sandbox options | maps to `ThreadOptions` (sandbox/network/websearch/approval) |
| Session reasoning | `SessionConfig.reasoningEffort` | sets `Options.maxThinkingTokens` | sets `ThreadOptions.modelReasoningEffort` |
| Session provider config | `SessionConfig.provider` | merged into Claude `Options` | merged into `ThreadOptions` |
| Session workspace | `SessionConfig.workspace` | sets `cwd` + `additionalDirectories` | sets `workingDirectory` + `additionalDirectories` *(only if workspace is provided)* |
| Session model | `SessionConfig.model` | sets `Options.model` | sets `ThreadOptions.model` |
| Run provider config | `RunConfig.provider` | merged (best-effort) into `Options` | not supported (`never`) |
| Run structured output | `RunConfig.outputSchema` | sets `options.outputFormat` | sets `turnOptions.outputSchema` |
| Run cancellation | `RunConfig.signal` | mirrors into `options.abortController` | mirrors into `turnOptions.signal` |

## Unified-owned keys (avoid “double sources of truth”)

Some provider SDK options are deliberately **owned by unified config** and therefore excluded from the provider config types:

| Provider | Owned by unified config | Where to set it |
|---|---|---|
| Claude | `cwd`, `additionalDirectories`, `model`, `resume`, `abortController`, `maxThinkingTokens` | `SessionConfig.workspace`, `SessionConfig.model`, `SessionConfig.reasoningEffort`, `resumeSession()`, `RunConfig.signal` |
| Codex | `workingDirectory`, `additionalDirectories`, `model`, `modelReasoningEffort` | `SessionConfig.workspace`, `SessionConfig.model`, `SessionConfig.reasoningEffort` |

If you’re looking for an orchestrator-friendly constructor, see `docs/orchestrator.md` and `createRuntime()` in `@unified-agent-sdk/runtime`.

### Codex permission mapping note

The Codex adapter maps `SessionConfig.access.auto` into `ThreadOptions.sandboxMode` and uses Codex sandbox modes as the primary enforcement mechanism:
- `auto="low"` → `sandboxMode: "read-only"`
- `auto="medium"` → `sandboxMode: "workspace-write"`
- `auto="high"` → `sandboxMode: "danger-full-access"` (unrestricted; use with caution)
