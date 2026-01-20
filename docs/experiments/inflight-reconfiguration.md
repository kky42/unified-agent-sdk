# In-Flight Session Reconfiguration (Experiments)

These experiments verify which unified-agent-sdk `SessionConfig` fields can be changed **mid-session** (without losing conversation history).

This matters for orchestrators that keep long-lived sessions and want to adjust settings like model, reasoning effort, or access level over time.

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
| **workspace.cwd** | ✅ Works | ✅ Works |
| **workspace.additionalDirs** | ✅ Works | ✅ Works |
| **access.auto** (low→medium) | ✅ Works | ✅ Works |
| **access.network** | ✅ Works | ✅ Works |
| **access.webSearch** (enable) | ✅ Works | ✅ Works |
| **access.webSearch** (disable) | ✅ Works | ⚠️ May fail* |

*Claude caveat: Restricting tools that were previously used in the conversation may not be enforced due to conversation context influence.

## How It Works

`UnifiedSession` has no setters. To change config mid-session:

1. Call `session.snapshot()` → `SessionHandle`
2. Mutate `handle.metadata.unifiedAgentSdk.sessionConfig`
3. Call `runtime.resumeSession(handle)` → new session with updated config

Conversation history is preserved (same native `sessionId`).

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

### WebSearch Toggle
- **Enable** (false → true): Works for both providers
- **Disable** (true → false): Works for Codex, but Claude may still use WebSearch if it was used earlier in the conversation

## Security Consideration

For security-critical access restrictions with Claude, consider starting a fresh session rather than resuming, as conversation context may override tool restrictions.

## See Also

- [Configuration](../guides/config.md)
- [Access & Sandboxing](access.md)
