import assert from "node:assert/strict";
import test from "node:test";

import { CodexRuntime } from "@unified-agent-sdk/provider-codex";
import { SessionBusyError, UNIFIED_AGENT_SDK_SESSION_HANDLE_METADATA_KEY } from "@unified-agent-sdk/runtime-core";

class FakeThread {
  constructor(makeEvents) {
    this._id = null;
    this._makeEvents = makeEvents;
  }

  get id() {
    return this._id;
  }

  async runStreamed(input, turnOptions = {}) {
    return { events: this._makeEvents(this, input, turnOptions) };
  }
}

class FakeCodex {
  constructor(makeEvents) {
    this._makeEvents = makeEvents;
  }

  startThread() {
    return new FakeThread(this._makeEvents);
  }

  resumeThread(id) {
    const thread = new FakeThread(this._makeEvents);
    thread._id = id;
    return thread;
  }
}

class CapturingCodex {
  constructor(makeEvents) {
    this.lastThreadOptions = null;
    this._makeEvents = makeEvents;
  }

  startThread(options) {
    this.lastThreadOptions = options ?? null;
    return new FakeThread(this._makeEvents);
  }
}

class CapturingCodexWithResume {
  constructor(makeEvents) {
    this.lastStartThreadOptions = null;
    this.lastResumeThreadOptions = null;
    this._makeEvents = makeEvents;
  }

  startThread(options) {
    this.lastStartThreadOptions = options ?? null;
    return new FakeThread(this._makeEvents);
  }

  resumeThread(id, options) {
    this.lastResumeThreadOptions = options ?? null;
    const thread = new FakeThread(this._makeEvents);
    thread._id = id;
    return thread;
  }
}

test("CodexSession.cancel(runId) aborts the run and reports cancelled", async () => {
  const runtime = new CodexRuntime({
    codex: new FakeCodex(async function* (_thread, _input, turnOptions) {
      const signal = turnOptions.signal;
      yield { type: "thread.started", thread_id: "t1" };
      yield { type: "turn.started" };
      await new Promise((resolve) => {
        if (signal.aborted) return resolve();
        signal.addEventListener("abort", resolve, { once: true });
      });
      throw new Error("aborted");
    }),
  });

  const session = await runtime.openSession({ config: { workspace: { cwd: process.cwd() } } });
  const run = await session.run({ input: { parts: [{ type: "text", text: "hello" }] } });

  const events = [];
  for await (const ev of run.events) {
    events.push(ev);
    if (ev.type === "run.started") await session.cancel(run.runId);
  }

  const done = events.find((e) => e.type === "run.completed");
  assert.ok(done, "expected run.completed event");
  assert.equal(done.status, "cancelled");
});

test("Codex adapter mirrors an already-aborted RunConfig.signal into the internal AbortController", async () => {
  let sawAborted = false;
  let sawReason;

  const runtime = new CodexRuntime({
    codex: new FakeCodex(async function* (_thread, _input, turnOptions) {
      sawAborted = Boolean(turnOptions.signal?.aborted);
      sawReason = turnOptions.signal?.reason;
    }),
  });

  const session = await runtime.openSession({ config: { workspace: { cwd: process.cwd() } } });
  const external = new AbortController();
  external.abort("already");

  const run = await session.run({
    input: { parts: [{ type: "text", text: "hello" }] },
    config: { signal: external.signal },
  });

  let done;
  for await (const ev of run.events) {
    if (ev.type === "run.completed") done = ev;
  }

  assert.equal(sawAborted, true);
  assert.equal(sawReason, "already");
  assert.ok(done, "expected run.completed event");
  assert.equal(done.status, "cancelled");
});

test("Codex adapter removes external abort listener after run completes", async () => {
  const listeners = new Set();
  let addCalls = 0;
  let removeCalls = 0;

  const signal = {
    aborted: false,
    reason: undefined,
    addEventListener: (type, callback) => {
      if (type !== "abort") return;
      addCalls += 1;
      listeners.add(callback);
    },
    removeEventListener: (type, callback) => {
      if (type !== "abort") return;
      removeCalls += 1;
      listeners.delete(callback);
    },
  };

  const runtime = new CodexRuntime({
    codex: new FakeCodex(async function* (thread) {
      thread._id = "t_listener_cleanup";
      yield { type: "thread.started", thread_id: "t_listener_cleanup" };
      yield { type: "turn.completed", usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 } };
    }),
  });

  const session = await runtime.openSession({ config: { workspace: { cwd: process.cwd() } } });
  const run = await session.run({ input: { parts: [{ type: "text", text: "hi" }] }, config: { signal } });

  for await (const _ev of run.events) {
    // drain
  }

  const done = await run.result;
  assert.equal(done.status, "success");

  assert.equal(addCalls, 1);
  assert.equal(removeCalls, 1);
  assert.equal(listeners.size, 0);
});

test("Codex adapter resolves run.result even when events are not consumed", async () => {
  const runtime = new CodexRuntime({
    codex: new FakeCodex(async function* (thread) {
      thread._id = "t_result_only";
      yield { type: "thread.started", thread_id: "t_result_only" };
      yield { type: "item.completed", item: { id: "m1", type: "agent_message", text: "ok" } };
      yield { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } };
    }),
  });

  const session = await runtime.openSession({ config: { workspace: { cwd: process.cwd() } } });
  const run = await session.run({ input: { parts: [{ type: "text", text: "hello" }] } });

  const done = await run.result;
  assert.equal(done.type, "run.completed");
  assert.equal(done.status, "success");
  assert.equal((await session.status()).state, "idle");
});

test("Codex adapter maps file_change to tool.call/tool.result (WorkspacePatchApplied)", async () => {
  const runtime = new CodexRuntime({
    codex: new FakeCodex(async function* () {
      yield { type: "thread.started", thread_id: "t_file_change" };
      yield { type: "turn.started" };
      yield {
        type: "item.completed",
        item: {
          id: "fc_1",
          type: "file_change",
          changes: [{ path: "src/example.ts", kind: "update" }],
          status: "completed",
        },
      };
      yield { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } };
    }),
  });

  const session = await runtime.openSession({ config: { workspace: { cwd: process.cwd() } } });
  const run = await session.run({ input: { parts: [{ type: "text", text: "hello" }] } });

  const events = [];
  for await (const ev of run.events) events.push(ev);

  const call = events.find((e) => e.type === "tool.call" && e.toolName === "WorkspacePatchApplied");
  assert.ok(call, "expected tool.call WorkspacePatchApplied");
  assert.deepEqual(call.input, { changes: [{ path: "src/example.ts", kind: "update" }] });

  const result = events.find((e) => e.type === "tool.result" && e.callId === call.callId);
  assert.ok(result, "expected tool.result WorkspacePatchApplied");
  assert.deepEqual(result.output, { status: "completed", changes: [{ path: "src/example.ts", kind: "update" }] });
});

test("Codex adapter defaults cached_input_tokens to 0 and does not double-count cache tokens in total_tokens", async () => {
  const runtime = new CodexRuntime({
    codex: new FakeCodex(async function* (thread) {
      thread._id = "t_usage";
      yield { type: "thread.started", thread_id: "t_usage" };
      yield { type: "turn.completed", usage: { input_tokens: 2, output_tokens: 3 } };
    }),
  });

  const session = await runtime.openSession({ config: { workspace: { cwd: process.cwd() } } });
  const run = await session.run({ input: { parts: [{ type: "text", text: "hello" }] } });

  let done;
  for await (const ev of run.events) {
    if (ev.type === "run.completed") done = ev;
  }

  assert.ok(done, "expected run.completed event");
  assert.equal(done.status, "success");
  assert.equal(done.usage.input_tokens, 2);
  assert.equal(done.usage.output_tokens, 3);
  assert.equal(done.usage.cache_read_tokens, 0);
  assert.equal(done.usage.total_tokens, 5);
  assert.ok(Number.isFinite(done.usage.total_tokens));
});

test("CodexSession.run rejects concurrent runs (SessionBusyError)", async () => {
  const runtime = new CodexRuntime({
    codex: new FakeCodex(async function* (thread, _input, turnOptions) {
      const signal = turnOptions.signal;
      thread._id = "t_busy";
      yield { type: "thread.started", thread_id: "t_busy" };
      yield { type: "turn.started" };
      await new Promise((resolve) => {
        if (signal.aborted) return resolve();
        signal.addEventListener("abort", resolve, { once: true });
      });
      throw new Error("aborted");
    }),
  });

  const session = await runtime.openSession({ config: { workspace: { cwd: process.cwd() } } });
  const run1 = await session.run({ input: { parts: [{ type: "text", text: "first" }] } });

  await assert.rejects(
    () => session.run({ input: { parts: [{ type: "text", text: "second" }] } }),
    (e) => e instanceof SessionBusyError && e.activeRunId === run1.runId,
  );

  await run1.cancel();
  const done = await run1.result;
  assert.equal(done.status, "cancelled");
});

test("Codex adapter best-effort parses structured output when outputSchema is set", async () => {
  const runtime = new CodexRuntime({
    codex: new FakeCodex(async function* (thread, _input, _turnOptions) {
      thread._id = "t2";
      yield { type: "thread.started", thread_id: "t2" };
      yield { type: "item.completed", item: { id: "m1", type: "agent_message", text: "{\"hello\":\"world\"}" } };
      yield { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } };
    }),
  });

  const session = await runtime.openSession({ config: { workspace: { cwd: process.cwd() } } });
  const run = await session.run({
    input: { parts: [{ type: "text", text: "hello" }] },
    config: { outputSchema: { type: "object" } },
  });

  let done;
  for await (const ev of run.events) {
    if (ev.type === "run.completed") done = ev;
  }

  assert.ok(done, "expected run.completed event");
  assert.equal(done.status, "success");
  assert.equal(done.finalText, "{\"hello\":\"world\"}");
  assert.deepEqual(done.structuredOutput, { hello: "world" });
});

test("Codex adapter wraps non-object outputSchema roots and unwraps structuredOutput", async () => {
  const runtime = new CodexRuntime({
    codex: new FakeCodex(async function* (thread, _input, turnOptions) {
      assert.equal(typeof turnOptions.outputSchema, "object");
      assert.ok(turnOptions.outputSchema && turnOptions.outputSchema.type === "object", "expected wrapped outputSchema.type=object");

      thread._id = "t2_array";
      yield { type: "thread.started", thread_id: "t2_array" };
      yield { type: "item.completed", item: { id: "m1", type: "agent_message", text: "{\"value\":[1,2,3]}" } };
      yield { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } };
    }),
  });

  const session = await runtime.openSession({ config: { workspace: { cwd: process.cwd() } } });
  const run = await session.run({
    input: { parts: [{ type: "text", text: "return numbers" }] },
    config: { outputSchema: { type: "array", items: { type: "integer" } } },
  });

  let done;
  for await (const ev of run.events) {
    if (ev.type === "run.completed") done = ev;
  }

  assert.ok(done, "expected run.completed event");
  assert.equal(done.status, "success");
  assert.equal(done.finalText, "{\"value\":[1,2,3]}");
  assert.deepEqual(done.structuredOutput, [1, 2, 3]);
});

test("Codex adapter maps reasoning items to assistant.reasoning.message", async () => {
  const runtime = new CodexRuntime({
    codex: new FakeCodex(async function* (thread) {
      thread._id = "t3";
      yield { type: "thread.started", thread_id: "t3" };
      yield {
        type: "item.completed",
        item: {
          id: "r1",
          type: "reasoning",
          text: "I will inspect the repo and summarize issues.",
        },
      };
      yield { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } };
    }),
  });

  const session = await runtime.openSession({ config: { workspace: { cwd: process.cwd() } } });
  const run = await session.run({ input: { parts: [{ type: "text", text: "hello" }] } });

  const reasoningMessages = [];
  for await (const ev of run.events) {
    if (ev.type === "assistant.reasoning.message") reasoningMessages.push(ev.message.text);
  }
  assert.deepEqual(reasoningMessages, ["I will inspect the repo and summarize issues."]);
});

test("Codex adapter injects image placeholders to preserve multimodal part ordering", async () => {
  const runtime = new CodexRuntime({
    codex: new FakeCodex(async function* (thread, input) {
      assert.ok(Array.isArray(input), "expected structured (multimodal) input array");
      assert.deepEqual(input, [
        {
          type: "text",
          text: "t1.before\n\n[Image #1]\n\nt1.after\n\nt2\n\n[Image #2]",
        },
        { type: "local_image", path: "C:\\imgs\\first.png" },
        { type: "local_image", path: "/tmp/second.jpg" },
      ]);

      thread._id = "t_mm";
      yield { type: "thread.started", thread_id: "t_mm" };
      yield { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } };
    }),
  });

  const session = await runtime.openSession({ config: { workspace: { cwd: process.cwd() } } });
  const run = await session.run({
    input: [
      {
        parts: [
          { type: "text", text: "t1.before" },
          { type: "local_image", path: "C:\\imgs\\first.png" },
          { type: "text", text: "t1.after" },
        ],
      },
      { parts: [{ type: "text", text: "t2" }, { type: "local_image", path: "/tmp/second.jpg" }] },
    ],
  });

  for await (const _ev of run.events) {
    // drain
  }
});

test("Codex adapter maps unified SessionConfig.access into ThreadOptions (auto only + default)", async (t) => {
  const makeEvents = async function* (thread) {
    thread._id = "t_perm";
    yield { type: "thread.started", thread_id: "t_perm" };
    yield { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } };
  };

  const cases = [
    { name: "default", access: undefined, expected: { sandboxMode: "workspace-write" } },
    { name: "auto=low", access: { auto: "low" }, expected: { sandboxMode: "read-only" } },
    { name: "auto=medium", access: { auto: "medium" }, expected: { sandboxMode: "workspace-write" } },
    { name: "auto=high", access: { auto: "high" }, expected: { sandboxMode: "danger-full-access" } },
  ];

  for (const c of cases) {
    await t.test(c.name, async () => {
      const codex = new CapturingCodex(makeEvents);
      const runtime = new CodexRuntime({ codex });

      const session = await runtime.openSession({
        config: { workspace: { cwd: process.cwd() }, ...(c.access ? { access: c.access } : {}) },
      });
      const run = await session.run({ input: { parts: [{ type: "text", text: "hi" }] } });
      for await (const _ev of run.events) {
        // drain
      }

      assert.ok(codex.lastThreadOptions, "expected thread options to be captured");
      assert.equal(codex.lastThreadOptions.approvalPolicy, "never");

      assert.equal(codex.lastThreadOptions.sandboxMode, c.expected.sandboxMode);
      assert.equal(codex.lastThreadOptions.networkAccessEnabled, true);
      assert.equal(codex.lastThreadOptions.webSearchEnabled, true);
      assert.equal(codex.lastThreadOptions.modelReasoningEffort, "medium");
    });
  }
});

test("Codex adapter maps unified SessionConfig.reasoningEffort into ThreadOptions.modelReasoningEffort", async (t) => {
  const makeEvents = async function* () {};
  const cases = [
    { name: "default", reasoningEffort: undefined, expected: "medium" },
    { name: "none", reasoningEffort: "none", expected: "minimal" },
    { name: "low", reasoningEffort: "low", expected: "low" },
    { name: "medium", reasoningEffort: "medium", expected: "medium" },
    { name: "high", reasoningEffort: "high", expected: "high" },
    { name: "xhigh", reasoningEffort: "xhigh", expected: "xhigh" },
  ];

  for (const c of cases) {
    await t.test(c.name, async () => {
      const codex = new CapturingCodex(makeEvents);
      const runtime = new CodexRuntime({ codex });

      await runtime.openSession({
        config: { workspace: { cwd: process.cwd() }, ...(c.reasoningEffort ? { reasoningEffort: c.reasoningEffort } : {}) },
      });

      assert.ok(codex.lastThreadOptions, "expected thread options to be captured");
      assert.equal(codex.lastThreadOptions.modelReasoningEffort, c.expected);
    });
  }
});

test("Codex resumeSession restores unified session config from snapshot metadata", async () => {
  const makeEvents = async function* (thread) {
    thread._id = "t_resume";
    yield { type: "thread.started", thread_id: "t_resume" };
    yield { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } };
  };

  const codex = new CapturingCodexWithResume(makeEvents);
  const runtime = new CodexRuntime({ codex });

  const session = await runtime.openSession({
    config: {
      workspace: { cwd: "/repo", additionalDirs: ["/extra"] },
      access: { auto: "low" },
      model: "gpt-5",
      reasoningEffort: "high",
    },
  });

  const run = await session.run({ input: { parts: [{ type: "text", text: "hello" }] } });
  for await (const _ev of run.events) {
    // drain
  }

  const handle = await session.snapshot();
  assert.equal(handle.sessionId, "t_resume");
  assert.ok(handle.metadata?.[UNIFIED_AGENT_SDK_SESSION_HANDLE_METADATA_KEY], "expected unified metadata entry");

  await runtime.resumeSession(handle);
  assert.ok(codex.lastResumeThreadOptions, "expected resumeThread to receive options");
  assert.equal(codex.lastResumeThreadOptions.workingDirectory, "/repo");
  assert.deepEqual(codex.lastResumeThreadOptions.additionalDirectories, ["/extra"]);
  assert.equal(codex.lastResumeThreadOptions.model, "gpt-5");
  assert.equal(codex.lastResumeThreadOptions.modelReasoningEffort, "high");
  assert.equal(codex.lastResumeThreadOptions.sandboxMode, "read-only");
  assert.equal(codex.lastResumeThreadOptions.networkAccessEnabled, true);
  assert.equal(codex.lastResumeThreadOptions.webSearchEnabled, true);
  assert.equal(codex.lastResumeThreadOptions.approvalPolicy, "never");
});
