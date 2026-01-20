# In-Flight Session Reconfiguration

Experiments verifying that unified-agent-sdk `SessionConfig` fields can be changed mid-session. These findings are relevant to hi-boss's agent session management.

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

## hi-boss Relevance

hi-boss stores session config in `provider_session_refs.session_config_json`. When resuming a session, hi-boss could:

1. Load the stored `sessionConfig` from SQLite
2. Apply any runtime overrides (e.g., user changed model preference)
3. Resume the unified session with the modified handle

This enables dynamic config changes without losing conversation context.

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

## hi-boss Implementation Example

```typescript
// In hibossd.ts or similar
async function updateAgentConfigMidSession(
  agentId: string,
  updates: { model?: string; autoLevel?: "low" | "medium" | "high" },
) {
  // 1. Get current session
  const psr = store.getActiveProviderSessionRef(conversationId);
  const currentConfig = JSON.parse(psr.sessionConfigJson);

  // 2. Mutate the config
  const newConfig = {
    ...currentConfig,
    ...(updates.model ? { model: updates.model } : {}),
    ...(updates.autoLevel ? { access: { ...currentConfig.access, auto: updates.autoLevel } } : {}),
  };

  // 3. Build new handle and resume
  const handle: SessionHandle = {
    provider: psr.provider,
    sessionId: psr.nativeSessionId,
    metadata: {
      [UNIFIED_AGENT_SDK_SESSION_HANDLE_METADATA_KEY]: {
        version: 1,
        sessionConfig: newConfig,
      },
    },
  };

  const newSession = await runtime.resumeSession(handle);

  // 4. Update stored config
  store.updateProviderSessionRef(psr.providerSessionRefId, {
    sessionConfigJson: JSON.stringify(newConfig),
  });
}
```

## Security Consideration

For security-critical access restrictions with Claude, consider starting a fresh session rather than resuming, as conversation context may override tool restrictions.

## Test Date

2026-01-20

## See Also

- `unified-agent-sdk/docs/experiment/inflight-reconfiguration.md` - Full experiment details
- `unified-agent-sdk/docs/guides/config.md` - Config reference
