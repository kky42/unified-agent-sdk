# In-Flight Session Reconfiguration (Experiments)

These experiments verify which unified-agent-sdk `SessionConfig` fields can be changed **mid-session** (without losing conversation history).

This matters for orchestrators that keep long-lived sessions and want to adjust settings like model, reasoning effort, or access level over time.

Note: these are exploratory results. For the consolidated, point-in-time e2e matrix used to answer “does it work end-to-end?”, see [2026-01-23: Permission E2E Testing](2026-01-23-permission-e2e-testing.md).

Note: `uagent` interactive mode does **not** implement in-session config commands (only `/exit`). To test in-flight reconfiguration from the CLI, use `uagent --dump-handle ...` and then `uagent resume --handle ...` to apply new settings via the `snapshot()`/metadata/`resumeSession()` flow.

## Tested on (point-in-time)

| Item | Value |
|---|---|
| Test date | 2026-01-20 |
| Providers | Codex + Claude (via the built-in adapters) |

## Summary

| Setting | Codex | Claude |
|---------|-------|--------|
| **model** | ✅ Works, history preserved | ✅ Works, history preserved |
| **reasoningEffort** | ✅ Works | ✅ Works |
| **workspace.cwd** | ✅ Works | ❌ Fails in practice* |
| **workspace.additionalDirs** | ✅ Works | ✅ Works |
| **access.auto** (low→medium) | ✅ Works | ✅ Works |
| **access.auto** (medium→high) | ✅ Works | ✅ Works |

*Claude caveats:
- In this environment, resuming with a different `workspace.cwd` caused Claude Code to exit with an error even when the directory exists. Treat `cwd` changes as “start a new session”.
- Restricting tools that were previously used in the conversation may not be enforced due to conversation context influence.

## How It Works

`UnifiedSession` has no setters. To change config mid-session:

1. Call `session.snapshot()` → `SessionHandle`
2. Mutate `handle.metadata.unifiedAgentSdk.sessionConfig`
3. Call `runtime.resumeSession(handle)` → new session with updated config

Conversation history is preserved (same native `sessionId`).

## Secret-word verification pattern (recommended)

For access/workspace changes, validate **all three**:
1) **Context preserved** (the assistant recalls a secret word)
2) **Session preserved** (native `sessionId` unchanged)
3) **Policy changed** (restricted action denied before, allowed after)

Example recipe:

1) Start with restrictive config (e.g. `access.auto="low"`).
2) Ask the agent to remember a secret word and attempt a restricted action (e.g. write a file). Confirm denial.
3) `snapshot()` → mutate metadata to upgrade permissions (e.g. `access.auto="medium"`).
4) `resumeSession(handle)` and confirm `resumed.sessionId === original.sessionId`.
5) Ask for the secret word (proves same conversation history).
6) Retry the restricted action (should now succeed).

## Example: update `access.auto` mid-session

Adapters may include a unified session config snapshot inside `SessionHandle.metadata["unifiedAgentSdk"]`.
You can also set/overwrite this field yourself before calling `resumeSession()`.

```ts
import {
  UNIFIED_AGENT_SDK_SESSION_HANDLE_METADATA_KEY,
  type UnifiedAgentSdkSessionHandleMetadataV1,
} from "@unified-agent-sdk/runtime-core";

const handle = await session.snapshot();
const metadata = (handle.metadata ??= {});

const existing = metadata[UNIFIED_AGENT_SDK_SESSION_HANDLE_METADATA_KEY] as
  | UnifiedAgentSdkSessionHandleMetadataV1
  | undefined;

metadata[UNIFIED_AGENT_SDK_SESSION_HANDLE_METADATA_KEY] = {
  version: 1,
  sessionConfig: {
    // keep whatever you already had, then override what you want
    ...(existing?.sessionConfig ?? {}),
    access: { auto: "medium" },
  },
};

const resumed = await runtime.resumeSession(handle);
```

## Detailed Findings

### Model Change
- Both providers preserve conversation history when switching models
- Tested: Claude (sonnet → haiku), Codex (gpt-5.2 → gpt-5.2-codex)

### Access Level Upgrade (auto: low → medium)
- File writes blocked in read-only mode, allowed after upgrade
- Works for both providers

## Security Consideration

For security-critical access restrictions with Claude, consider starting a fresh session rather than resuming, as conversation context may override tool restrictions.

## See Also

- [Configuration](../guides/config.md)
- [Permission E2E Testing](2026-01-23-permission-e2e-testing.md)
