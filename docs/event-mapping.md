# Event Mapping (Unified ↔ Codex ↔ Claude)

This document summarizes how the `@unified-agent-sdk/runtime-core` event model maps to:
- `@openai/codex-sdk` (Codex)
- `@anthropic-ai/claude-agent-sdk` (Claude Code / Claude Agent SDK)

Legend:
- ✅ strong/explicit support (reliable)
- 🟡 best-effort / derived (may be incomplete)
- ❌ not available from that source without extra integration

## High-level mapping

| Unified concept / event | Codex SDK (source) | Claude Agent SDK (source) | Support notes |
|---|---|---|---|
| `run.started` | `ThreadEvent.type="turn.started"` (or first event in the turn) | no single “turn started” message; emit at first message observed | Codex has explicit turn lifecycle; Claude is stream/message-based. |
| `assistant.delta` (final text stream) | `item.updated` / `item.started` where `item.type="agent_message"` (incremental `item.text`) | `SDKPartialAssistantMessage` (`type:"stream_event"`) where `event.type="content_block_delta"` and `delta.type="text_delta"` | Both can stream final text. Codex depends on whether the Codex CLI emits `item.updated`. |
| `assistant.message` (final text) | `item.completed` where `item.type="agent_message"` | `SDKAssistantMessage` (`type:"assistant"`) extract `BetaMessage.content` text blocks (and/or `result.result`) | Both support. |
| `assistant.reasoning.delta` / `assistant.reasoning.message` | `item.updated` / `item.completed` where `item.type="reasoning"` | `SDKPartialAssistantMessage` with thinking-style deltas (provider-specific) and/or assistant message content blocks | Codex explicitly tags reasoning; Claude requires parsing thinking blocks from the stream/message content. |
| `tool.call` | `item.started` for `command_execution`, `web_search`, `mcp_tool_call` ✅ | **Hooks** `PreToolUse` (reliable) ✅; assistant `tool_use` blocks ✅ | Claude tool calls are most reliable via hooks or `tool_use` blocks; `tool_progress` is treated as provider-only and does not emit a unified `tool.call`. |
| `tool.result` | `item.completed` for those tool items ✅ | best-effort by parsing `tool_result` blocks in subsequent messages 🟡; **Hooks** `PostToolUse` (reliable) ✅ | Hooks provide both input and output cleanly. |
| `run.completed` | `ThreadEvent.type="turn.completed"` / `turn.failed` mapped to `run.completed` | `SDKResultMessage` (`type:"result"`) mapped to `run.completed` | Both support. |
| `provider.event` (raw passthrough) | any Codex `ThreadEvent` not mapped to a unified event | any Claude `SDKMessage` not mapped to a unified event | Use for debugging and to evolve mappings safely. |
| `usage` | Codex `turn.completed.usage` | Claude `result.usage` | Unified token fields: `input_tokens`, `cache_read_tokens`, `cache_write_tokens`, `output_tokens` (Codex `cache_write_tokens=0`). |

## Provider-native “reasoning” / “plan”

These are important in modern agent UX. Today:
- **Reasoning/thinking is part of the unified event contract** via `assistant.reasoning.delta` and `assistant.reasoning.message` (support quality varies by provider).
- **Plan/todo updates are not yet first-class** in the unified contract (Codex has `todo_list`; Claude has model/tooling-dependent plan representations).

- Codex SDK has explicit item types:
  - `ThreadItem.type="reasoning"` (reasoning summary)
  - `ThreadItem.type="todo_list"` (plan/todo list, can update during the turn)
- Claude Agent SDK can expose “thinking”/reasoning as typed content blocks in the streaming protocol; mapping requires parsing those block/delta types (which can vary by model/settings).

Recommended direction (future):
- Extend the unified event model with a first-class representation for:
  - plan/todo updates
so TUIs can render these without relying on `provider.event`.
