import assert from "node:assert/strict";
import test from "node:test";

import { CodexRuntime } from "@unified-agent-sdk/provider-codex";
import { SessionBusyError } from "@unified-agent-sdk/runtime-core";

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

  const session = await runtime.openSession({ sessionId: "s1", config: { workspace: { cwd: process.cwd() } } });
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

test("Codex adapter resolves run.result even when events are not consumed", async () => {
  const runtime = new CodexRuntime({
    codex: new FakeCodex(async function* (thread) {
      thread._id = "t_result_only";
      yield { type: "thread.started", thread_id: "t_result_only" };
      yield { type: "item.completed", item: { id: "m1", type: "agent_message", text: "ok" } };
      yield { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } };
    }),
  });

  const session = await runtime.openSession({ sessionId: "s_result_only", config: { workspace: { cwd: process.cwd() } } });
  const run = await session.run({ input: { parts: [{ type: "text", text: "hello" }] } });

  const done = await run.result;
  assert.equal(done.type, "run.completed");
  assert.equal(done.status, "success");
  assert.equal((await session.status()).state, "idle");
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

  const session = await runtime.openSession({ sessionId: "s_busy", config: { workspace: { cwd: process.cwd() } } });
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

  const session = await runtime.openSession({ sessionId: "s2", config: { workspace: { cwd: process.cwd() } } });
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

  const session = await runtime.openSession({ sessionId: "s2_array", config: { workspace: { cwd: process.cwd() } } });
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

  const session = await runtime.openSession({ sessionId: "s3", config: { workspace: { cwd: process.cwd() } } });
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

  const session = await runtime.openSession({ sessionId: "s_mm", config: { workspace: { cwd: process.cwd() } } });
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

test("Codex adapter maps unified SessionConfig.access into ThreadOptions (auto x network x webSearch + default)", async (t) => {
  const makeEvents = async function* (thread) {
    thread._id = "t_perm";
    yield { type: "thread.started", thread_id: "t_perm" };
    yield { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } };
  };

  const cases = [{ name: "default", access: undefined, expected: { sandboxMode: "workspace-write", network: true, webSearch: true } }];
  for (const auto of ["low", "medium", "high"]) {
    for (const network of [false, true]) {
      for (const webSearch of [false, true]) {
        cases.push({ name: `auto=${auto} network=${network} webSearch=${webSearch}`, access: { auto, network, webSearch } });
      }
    }
  }

  for (const c of cases) {
    await t.test(c.name, async () => {
      const codex = new CapturingCodex(makeEvents);
      const runtime = new CodexRuntime({ codex });

      const session = await runtime.openSession({
        sessionId: "s_perm",
        config: { workspace: { cwd: process.cwd() }, ...(c.access ? { access: c.access } : {}) },
      });
      const run = await session.run({ input: { parts: [{ type: "text", text: "hi" }] } });
      for await (const _ev of run.events) {
        // drain
      }

      assert.ok(codex.lastThreadOptions, "expected thread options to be captured");
      assert.equal(codex.lastThreadOptions.approvalPolicy, "never");

      const expected =
        c.expected ??
        ({
          sandboxMode: c.access.auto === "low" ? "read-only" : c.access.auto === "medium" ? "workspace-write" : "danger-full-access",
          network: c.access.auto === "high" ? true : Boolean(c.access.network),
          webSearch: c.access.auto === "high" ? true : Boolean(c.access.webSearch),
        });

      assert.equal(codex.lastThreadOptions.sandboxMode, expected.sandboxMode);
      assert.equal(codex.lastThreadOptions.networkAccessEnabled, expected.network);
      assert.equal(codex.lastThreadOptions.webSearchEnabled, expected.webSearch);
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
        sessionId: `s_reasoning_${c.name}`,
        config: { workspace: { cwd: process.cwd() }, ...(c.reasoningEffort ? { reasoningEffort: c.reasoningEffort } : {}) },
      });

      assert.ok(codex.lastThreadOptions, "expected thread options to be captured");
      assert.equal(codex.lastThreadOptions.modelReasoningEffort, c.expected);
    });
  }
});
