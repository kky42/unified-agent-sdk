import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { ClaudeRuntime } from "@unified-agent-sdk/provider-claude";
import { SessionBusyError, UNIFIED_AGENT_SDK_SESSION_HANDLE_METADATA_KEY } from "@unified-agent-sdk/runtime-core";

test("ClaudeSession.cancel(runId) aborts the run and reports cancelled", async () => {
  const runtime = new ClaudeRuntime({
    query: ({ options }) =>
      (async function* () {
        const signal = options.abortController.signal;
        yield {
          type: "stream_event",
          event: { type: "content_block_delta", delta: { type: "text_delta", text: "hello" } },
        };
        if (signal.aborted) return;
        await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      })(),
  });

  const session = await runtime.openSession({ config: { workspace: { cwd: process.cwd() } } });
  const run = await session.run({ input: { parts: [{ type: "text", text: "hello" }] } });

  const events = [];
  for await (const ev of run.events) {
    events.push(ev);
    if (ev.type === "assistant.delta") await session.cancel(run.runId);
  }

  const done = events.find((e) => e.type === "run.completed");
  assert.ok(done, "expected run.completed event");
  assert.equal(done.status, "cancelled");
});

test("Claude adapter mirrors an already-aborted RunConfig.signal into the SDK abortController", async () => {
  let sawAborted = false;
  let sawReason;

  const runtime = new ClaudeRuntime({
    query: ({ options }) =>
      (async function* () {
        sawAborted = options.abortController.signal.aborted;
        sawReason = options.abortController.signal.reason;
      })(),
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

test("Claude adapter removes external abort listener after run completes", async () => {
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

  const runtime = new ClaudeRuntime({
    query: () =>
      (async function* () {
        yield {
          type: "result",
          subtype: "success",
          result: "ok",
          structured_output: null,
          total_cost_usd: 0,
          duration_ms: 1,
          usage: {},
        };
      })(),
  });

  const session = await runtime.openSession({ config: { workspace: { cwd: process.cwd() } } });
  const run = await session.run({ input: { parts: [{ type: "text", text: "hello" }] }, config: { signal } });

  for await (const _ev of run.events) {
    // drain
  }

  const done = await run.result;
  assert.equal(done.status, "success");

  assert.equal(addCalls, 1);
  assert.equal(removeCalls, 1);
  assert.equal(listeners.size, 0);
});

test("Claude adapter resolves run.result even when events are not consumed", async () => {
  const runtime = new ClaudeRuntime({
    query: () =>
      (async function* () {
        yield {
          type: "result",
          subtype: "success",
          result: "ok",
          structured_output: { status: "ok" },
          total_cost_usd: 0,
          duration_ms: 1,
          usage: {},
        };
      })(),
  });

  const session = await runtime.openSession({ config: { workspace: { cwd: process.cwd() } } });
  const run = await session.run({ input: { parts: [{ type: "text", text: "hello" }] } });

  const done = await run.result;
  assert.equal(done.type, "run.completed");
  assert.equal(done.status, "success");
  assert.equal((await session.status()).state, "idle");
});

test("Claude adapter normalizes cache token usage into unified breakdown fields", async () => {
  const runtime = new ClaudeRuntime({
    query: () =>
      (async function* () {
        yield {
          type: "result",
          subtype: "success",
          result: "ok",
          structured_output: null,
          total_cost_usd: 0,
          duration_ms: 1,
          usage: {
            input_tokens: 3,
            cache_read_input_tokens: 10,
            cache_creation_input_tokens: 20,
            output_tokens: 5,
          },
        };
      })(),
  });

  const session = await runtime.openSession({ config: { workspace: { cwd: process.cwd() } } });
  const run = await session.run({ input: { parts: [{ type: "text", text: "hello" }] } });

  const done = await run.result;
  assert.equal(done.status, "success");
  assert.equal(done.usage.input_tokens, 33);
  assert.equal(done.usage.cache_read_tokens, 10);
  assert.equal(done.usage.cache_write_tokens, 20);
  assert.equal(done.usage.output_tokens, 5);
  assert.equal(done.usage.total_tokens, 38);
});

test("ClaudeSession.run rejects concurrent runs (SessionBusyError)", async () => {
  const runtime = new ClaudeRuntime({
    query: ({ options }) =>
      (async function* () {
        const signal = options.abortController.signal;
        yield {
          type: "stream_event",
          event: { type: "content_block_delta", delta: { type: "text_delta", text: "hello" } },
        };
        if (signal.aborted) return;
        await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      })(),
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

test("Claude adapter forwards structured_output from SDK result", async () => {
  const runtime = new ClaudeRuntime({
    query: () =>
      (async function* () {
        yield {
          type: "result",
          subtype: "success",
          result: "ok",
          structured_output: { status: "ok" },
          total_cost_usd: 0,
          duration_ms: 1,
          usage: {},
        };
      })(),
  });

  const session = await runtime.openSession({ config: { workspace: { cwd: process.cwd() } } });
  const run = await session.run({ input: { parts: [{ type: "text", text: "hello" }] } });

  let done;
  for await (const ev of run.events) {
    if (ev.type === "run.completed") done = ev;
  }

  assert.ok(done, "expected run.completed event");
  assert.equal(done.status, "success");
  assert.deepEqual(done.structuredOutput, { status: "ok" });
});

test("Claude adapter wraps non-object outputSchema roots and unwraps structuredOutput", async () => {
  const runtime = new ClaudeRuntime({
    query: ({ options }) =>
      (async function* () {
        assert.equal(options.outputFormat?.type, "json_schema");
        assert.ok(options.outputFormat && options.outputFormat.schema && options.outputFormat.schema.type === "object");

        yield {
          type: "result",
          subtype: "success",
          result: "ok",
          structured_output: { value: [1, 2, 3] },
          total_cost_usd: 0,
          duration_ms: 1,
          usage: {},
        };
      })(),
  });

  const session = await runtime.openSession({ config: { workspace: { cwd: process.cwd() } } });
  const run = await session.run({
    input: { parts: [{ type: "text", text: "hello" }] },
    config: { outputSchema: { type: "array", items: { type: "integer" } } },
  });

  let done;
  for await (const ev of run.events) {
    if (ev.type === "run.completed") done = ev;
  }

  assert.ok(done, "expected run.completed event");
  assert.equal(done.status, "success");
  assert.deepEqual(done.structuredOutput, [1, 2, 3]);
});

test("Claude adapter forwards tool_progress as provider.event (not tool.call)", async () => {
  const runtime = new ClaudeRuntime({
    query: () =>
      (async function* () {
        yield {
          type: "tool_progress",
          tool_use_id: "tool_1",
          tool_name: "WebSearch",
          parent_tool_use_id: null,
          elapsed_time_seconds: 0,
          uuid: "00000000-0000-0000-0000-000000000000",
          session_id: "s",
        };
        yield {
          type: "tool_progress",
          tool_use_id: "tool_1",
          tool_name: "WebSearch",
          parent_tool_use_id: null,
          elapsed_time_seconds: 1,
          uuid: "00000000-0000-0000-0000-000000000000",
          session_id: "s",
        };
        yield {
          type: "result",
          subtype: "success",
          result: "ok",
          structured_output: null,
          total_cost_usd: 0,
          duration_ms: 1,
          usage: {},
        };
      })(),
  });

  const session = await runtime.openSession({ config: { workspace: { cwd: process.cwd() } } });
  const run = await session.run({ input: { parts: [{ type: "text", text: "hello" }] } });

  const toolCalls = [];
  const providerEvents = [];
  for await (const ev of run.events) {
    if (ev.type === "tool.call") toolCalls.push(ev);
    if (ev.type === "provider.event") providerEvents.push(ev);
  }

  assert.equal(toolCalls.length, 0);
  assert.equal(providerEvents.length, 2);
  assert.equal(providerEvents[0].payload?.type, "tool_progress");
  assert.equal(providerEvents[1].payload?.type, "tool_progress");
});

test("Claude adapter maps unified SessionConfig.access into Claude options (auto only + default)", async (t) => {
  const cases = [
    { name: "default", access: undefined },
    { name: "auto=low", access: { auto: "low" } },
    { name: "auto=medium", access: { auto: "medium" } },
    { name: "auto=high", access: { auto: "high" } },
  ];

  for (const c of cases) {
    await t.test(c.name, async () => {
      const runtime = new ClaudeRuntime({
        query: ({ options }) =>
          (async function* () {
            const auto = c.access?.auto ?? "medium";

            if (auto === "high") {
              assert.equal(options.permissionMode, "bypassPermissions");
              assert.equal(options.allowDangerouslySkipPermissions, true);
              assert.equal(options.sandbox?.enabled, false);
              assert.equal(options.canUseTool, undefined);
              assert.equal(options.permissionPromptToolName, undefined);
            } else {
              assert.equal(options.permissionMode, "default");
              assert.equal(options.sandbox?.enabled, auto === "medium");
              if (auto === "medium") {
                assert.equal(options.sandbox?.autoAllowBashIfSandboxed, false);
                assert.equal(options.sandbox?.allowUnsandboxedCommands, false);
                assert.ok(Array.isArray(options.sandbox?.network?.allowedDomains));
                assert.ok(options.sandbox?.network?.allowedDomains.includes("*.com"));
                assert.ok(options.sandbox?.network?.allowedDomains.includes("localhost"));
                assert.ok(options.sandbox?.network?.allowedDomains.includes("127.0.0.1"));
                assert.equal(options.sandbox?.network?.allowLocalBinding, true);
              }
              assert.equal(typeof options.canUseTool, "function");
              assert.equal(options.permissionPromptToolName, undefined);

              assert.ok(Array.isArray(options.disallowedTools));
              assert.ok(options.disallowedTools.includes("AskUserQuestion"));

              const decisionFor = async (toolName, toolInput = {}) => options.canUseTool(toolName, toolInput, {});

              assert.equal((await decisionFor("AskUserQuestion")).behavior, "deny");
              assert.equal((await decisionFor("WebFetch")).behavior, "allow");
              assert.equal((await decisionFor("WebSearch")).behavior, "allow");

              assert.equal((await decisionFor("Read")).behavior, "allow");
              assert.equal((await decisionFor("Grep")).behavior, "allow");

              assert.equal((await decisionFor("Write")).behavior, auto === "medium" ? "allow" : "deny");
              assert.equal((await decisionFor("Edit")).behavior, auto === "medium" ? "allow" : "deny");
              assert.equal((await decisionFor("Bash", { command: "rg -n hello README.md" })).behavior, "allow");

              if (auto === "low") {
                const bashDenied = await decisionFor("Bash", { command: "echo hi > /tmp/x" });
                assert.equal(bashDenied.behavior, "deny");
                assert.equal(bashDenied.interrupt, false);
                assert.equal((await decisionFor("Bash", { command: "find . -delete" })).behavior, "deny");
                assert.equal((await decisionFor("Bash", { command: "find . -maxdepth 1 -exec echo hi \\;" })).behavior, "deny");
                assert.equal((await decisionFor("Bash", { command: "find . -maxdepth 1 -name '*.md' -print" })).behavior, "allow");
                const curlDecision = await decisionFor("Bash", { command: "curl https://example.com" });
                assert.equal(curlDecision.behavior, "deny");
              } else {
                const bashAllowed = await decisionFor("Bash", { command: "echo hi > /tmp/x" });
                assert.equal(bashAllowed.behavior, "allow");
                const bashEscape = await decisionFor("Bash", { command: "echo hi", dangerouslyDisableSandbox: true });
                assert.equal(bashEscape.behavior, "deny");
              }
            }

            yield {
              type: "result",
              subtype: "success",
              result: "ok",
              structured_output: { ok: true },
              total_cost_usd: 0,
              duration_ms: 1,
              usage: {},
            };
          })(),
      });

      const session = await runtime.openSession({
        config: { workspace: { cwd: process.cwd() }, ...(c.access ? { access: c.access } : {}) },
      });
      const run = await session.run({ input: { parts: [{ type: "text", text: "hello" }] } });

      let done;
      for await (const ev of run.events) {
        if (ev.type === "run.completed") done = ev;
      }

      assert.ok(done, "expected run.completed event");
      assert.equal(done.status, "success");
      assert.deepEqual(done.structuredOutput, { ok: true });
    });
  }
});

test("Claude adapter maps unified SessionConfig.reasoningEffort into options.maxThinkingTokens", async (t) => {
  const cases = [
    { name: "default", reasoningEffort: undefined, expected: 8_000 },
    { name: "none", reasoningEffort: "none", expected: 0 },
    { name: "low", reasoningEffort: "low", expected: 4_000 },
    { name: "medium", reasoningEffort: "medium", expected: 8_000 },
    { name: "high", reasoningEffort: "high", expected: 12_000 },
    { name: "xhigh", reasoningEffort: "xhigh", expected: 16_000 },
  ];

  for (const c of cases) {
    await t.test(c.name, async () => {
      const runtime = new ClaudeRuntime({
        query: ({ options }) =>
          (async function* () {
            assert.equal(options.maxThinkingTokens, c.expected);
            yield {
              type: "result",
              subtype: "success",
              result: "ok",
              structured_output: null,
              total_cost_usd: 0,
              duration_ms: 1,
              usage: {},
            };
          })(),
      });

      const session = await runtime.openSession({
        config: { workspace: { cwd: process.cwd() }, ...(c.reasoningEffort ? { reasoningEffort: c.reasoningEffort } : {}) },
      });

      const run = await session.run({ input: { parts: [{ type: "text", text: "hello" }] } });
      const done = await run.result;
      assert.equal(done.status, "success");
    });
  }
});

test("Claude adapter denies out-of-workspace writes when auto=medium (but allows reads elsewhere)", async () => {
  const runtime = new ClaudeRuntime({
    query: ({ options }) =>
      (async function* () {
        assert.equal(typeof options.canUseTool, "function");

        const allowed = await options.canUseTool(
          "Write",
          { file_path: `${process.cwd()}/story.md`, content: "hi" },
          { blockedPath: `${process.cwd()}/story.md` },
        );
        assert.equal(allowed.behavior, "allow");

        const denied = await options.canUseTool(
          "Write",
          { file_path: "/tmp/outside.md", content: "nope" },
          { blockedPath: "/tmp/outside.md" },
        );
        assert.equal(denied.behavior, "deny");

        const traversal = await options.canUseTool(
          "Write",
          { file_path: `${process.cwd()}/sub/../../outside.md`, content: "nope" },
          { blockedPath: `${process.cwd()}/sub/../../outside.md` },
        );
        assert.equal(traversal.behavior, "deny");

        const readOutside = await options.canUseTool("Read", { file_path: "/etc/hosts" }, { blockedPath: "/etc/hosts" });
        assert.equal(readOutside.behavior, "allow");

        yield {
          type: "result",
          subtype: "success",
          result: "ok",
          structured_output: { ok: true },
          total_cost_usd: 0,
          duration_ms: 1,
          usage: {},
        };
      })(),
  });

  const session = await runtime.openSession({
    config: { workspace: { cwd: process.cwd() }, access: { auto: "medium" } },
  });
  const run = await session.run({ input: { parts: [{ type: "text", text: "hello" }] } });
  for await (const _ev of run.events) {
    // drain
  }
});

test("Claude adapter denies workspace escapes via symlinks when auto=medium", async (t) => {
  if (process.platform === "win32") t.skip("symlink behavior varies on Windows environments");

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "uagent-workspace-"));
  const workspaceDir = path.join(tmp, "ws");
  const outsideDir = path.join(tmp, "outside");
  const linkDir = path.join(workspaceDir, "link");
  try {
    fs.mkdirSync(workspaceDir);
    fs.mkdirSync(outsideDir);
    try {
      fs.symlinkSync(outsideDir, linkDir, "dir");
    } catch (e) {
      t.skip(`unable to create symlink: ${e}`);
    }

    const runtime = new ClaudeRuntime({
      query: ({ options }) =>
        (async function* () {
          assert.equal(typeof options.canUseTool, "function");

          const allowed = await options.canUseTool(
            "Write",
            { file_path: `${workspaceDir}/ok.md`, content: "hi" },
            { blockedPath: `${workspaceDir}/ok.md` },
          );
          assert.equal(allowed.behavior, "allow");

          const denied = await options.canUseTool(
            "Write",
            { file_path: `${linkDir}/escape.md`, content: "nope" },
            { blockedPath: `${linkDir}/escape.md` },
          );
          assert.equal(denied.behavior, "deny");

          yield {
            type: "result",
            subtype: "success",
            result: "ok",
            structured_output: { ok: true },
            total_cost_usd: 0,
            duration_ms: 1,
            usage: {},
          };
        })(),
    });

    const session = await runtime.openSession({
      config: { workspace: { cwd: workspaceDir }, access: { auto: "medium" } },
    });
    const run = await session.run({ input: { parts: [{ type: "text", text: "hello" }] } });
    await run.result;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("Claude adapter defaults settingSources to ['user','project'] when omitted", async () => {
  const runtime = new ClaudeRuntime({
    query: ({ options }) =>
      (async function* () {
        assert.deepEqual(options.settingSources, ["user", "project"]);
        yield {
          type: "result",
          subtype: "success",
          result: "ok",
          structured_output: { ok: true },
          total_cost_usd: 0,
          duration_ms: 1,
          usage: {},
        };
      })(),
  });

  const session = await runtime.openSession({ config: { workspace: { cwd: process.cwd() } } });
  const run = await session.run({ input: { parts: [{ type: "text", text: "hello" }] } });

  for await (const _ev of run.events) {
    // drain
  }
});

test("Claude adapter respects explicit settingSources (including empty array)", async () => {
  const runtime = new ClaudeRuntime({
    query: ({ options }) =>
      (async function* () {
        assert.deepEqual(options.settingSources, []);
        yield {
          type: "result",
          subtype: "success",
          result: "ok",
          structured_output: { ok: true },
          total_cost_usd: 0,
          duration_ms: 1,
          usage: {},
        };
      })(),
  });

  const session = await runtime.openSession({
    config: { workspace: { cwd: process.cwd() }, provider: { settingSources: [] } },
  });
  const run = await session.run({ input: { parts: [{ type: "text", text: "hello" }] } });

  for await (const _ev of run.events) {
    // drain
  }
});

test("Claude resumeSession restores unified session config from snapshot metadata", async () => {
  let call = 0;
  const runtime = new ClaudeRuntime({
    query: ({ options }) =>
      (async function* () {
        call += 1;

        assert.equal(options.cwd, "/repo");
        assert.deepEqual(options.additionalDirectories, ["/extra"]);
        assert.equal(options.model, "gpt-5");
        assert.equal(options.maxThinkingTokens, 12_000);

        if (call === 1) {
          assert.equal(options.resume, undefined);
        } else if (call === 2) {
          assert.equal(options.resume, "native_1");
        } else {
          throw new Error(`unexpected query() call count: ${call}`);
        }

        yield {
          session_id: "native_1",
          type: "result",
          subtype: "success",
          result: "ok",
          structured_output: null,
          total_cost_usd: 0,
          duration_ms: 1,
          usage: {},
        };
      })(),
  });

  const session = await runtime.openSession({
    config: {
      workspace: { cwd: "/repo", additionalDirs: ["/extra"] },
      access: { auto: "low" },
      model: "gpt-5",
      reasoningEffort: "high",
    },
  });

  const run1 = await session.run({ input: { parts: [{ type: "text", text: "hello" }] } });
  for await (const _ev of run1.events) {
    // drain
  }

  const handle = await session.snapshot();
  assert.equal(handle.sessionId, "native_1");
  assert.ok(handle.metadata?.[UNIFIED_AGENT_SDK_SESSION_HANDLE_METADATA_KEY], "expected unified metadata entry");

  const resumed = await runtime.resumeSession(handle);
  const run2 = await resumed.run({ input: { parts: [{ type: "text", text: "hello again" }] } });
  for await (const _ev of run2.events) {
    // drain
  }
});

test("Claude adapter resumes within the same UnifiedSession across runs", async () => {
  let call = 0;
  const runtime = new ClaudeRuntime({
    query: ({ options }) =>
      (async function* () {
        call += 1;
        if (call === 1) {
          assert.equal(options.resume, undefined);
        } else if (call === 2) {
          assert.equal(options.resume, "native_1");
        } else {
          throw new Error(`unexpected query() call count: ${call}`);
        }

        yield {
          session_id: "native_1",
          type: "result",
          subtype: "success",
          result: "ok",
          structured_output: null,
          total_cost_usd: 0,
          duration_ms: 1,
          usage: {},
        };
      })(),
  });

  const session = await runtime.openSession({ config: { workspace: { cwd: "/repo" } } });

  const run1 = await session.run({ input: { parts: [{ type: "text", text: "hello" }] } });
  for await (const _ev of run1.events) {
    // drain
  }
  assert.equal(session.sessionId, "native_1");

  const run2 = await session.run({ input: { parts: [{ type: "text", text: "hello again" }] } });
  for await (const _ev of run2.events) {
    // drain
  }
});
