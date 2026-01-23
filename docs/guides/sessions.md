# Sessions

The unified API has two main objects:
- `UnifiedAgentRuntime` (creates/resumes sessions)
- `UnifiedSession` (runs turns and streams `RuntimeEvent`s)

## Open a session

```ts
const session = await runtime.openSession({
  config: {
    workspace: { cwd: process.cwd() },
    model: "gpt-5",
    reasoningEffort: "medium",
    access: { auto: "medium" },
  },
});

// sessionId is undefined until the first run completes
console.log(session.sessionId); // undefined
```

## Run a turn

```ts
const run = await session.run({
  input: { parts: [{ type: "text", text: "Say hello." }] },
});

// After the run, sessionId is set to the provider's native session id
console.log(session.sessionId); // "abc-123" (from provider)
```

- `run.events` is an `AsyncIterable<RuntimeEvent>` (streaming)
- `run.result` resolves to the final `run.completed` event

## One run at a time

A `UnifiedSession` only supports one active `run()` at a time. If you call `run()` concurrently, it throws `SessionBusyError`.

## Dispose and close

```ts
await session.dispose();
await runtime.close();
```

## Snapshot and resume

If the provider supports it (`capabilities().sessionResume === true`), you can snapshot a session handle and resume later:

```ts
// Save the session handle (sessionId is the native provider id)
const handle = await session.snapshot();
console.log(handle.sessionId); // "abc-123" (Claude's session_id or Codex's thread_id)

// Later, resume the session
const resumed = await runtime.resumeSession(handle);
```

Notes:
- Persist the entire `SessionHandle` (including `metadata`) for lossless resume.
- Provider adapters in this repo store unified session config under `UNIFIED_AGENT_SDK_SESSION_HANDLE_METADATA_KEY` so `resumeSession(handle)` can restore `workspace` / `access` / `model` / `reasoningEffort`.
