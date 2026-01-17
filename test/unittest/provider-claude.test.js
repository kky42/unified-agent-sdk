import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { ClaudeRuntime } from "@unified-agent-sdk/provider-claude";
import { SessionBusyError } from "@unified-agent-sdk/runtime-core";

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

  const session = await runtime.openSession({ sessionId: "s1", config: { workspace: { cwd: process.cwd() } } });
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

  const session = await runtime.openSession({ sessionId: "s_result_only", config: { workspace: { cwd: process.cwd() } } });
  const run = await session.run({ input: { parts: [{ type: "text", text: "hello" }] } });

  const done = await run.result;
  assert.equal(done.type, "run.completed");
  assert.equal(done.status, "success");
  assert.equal((await session.status()).state, "idle");
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

  const session = await runtime.openSession({ sessionId: "s2", config: { workspace: { cwd: process.cwd() } } });
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

  const session = await runtime.openSession({ sessionId: "s2_array", config: { workspace: { cwd: process.cwd() } } });
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

  const session = await runtime.openSession({ sessionId: "s_tool_progress", config: { workspace: { cwd: process.cwd() } } });
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

test("Claude adapter maps unified SessionConfig.access into Claude options (auto x network x webSearch + default)", async (t) => {
  const cases = [{ name: "default", access: undefined }];
  for (const auto of ["low", "medium", "high"]) {
    for (const network of [false, true]) {
      for (const webSearch of [false, true]) {
        cases.push({ name: `auto=${auto} network=${network} webSearch=${webSearch}`, access: { auto, network, webSearch } });
      }
    }
  }

  for (const c of cases) {
    await t.test(c.name, async () => {
      const runtime = new ClaudeRuntime({
        query: ({ options }) =>
          (async function* () {
            const auto = c.access?.auto ?? "medium";
            const expectedNetwork = c.access?.network ?? true;
            const expectedWebSearch = c.access?.webSearch ?? true;

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
              }
              assert.equal(typeof options.canUseTool, "function");
              assert.equal(options.permissionPromptToolName, undefined);

              assert.ok(Array.isArray(options.disallowedTools));
              assert.ok(options.disallowedTools.includes("AskUserQuestion"));

              const decisionFor = async (toolName, toolInput = {}) => options.canUseTool(toolName, toolInput, {});

              assert.equal((await decisionFor("AskUserQuestion")).behavior, "deny");
              assert.equal((await decisionFor("WebFetch")).behavior, expectedNetwork ? "allow" : "deny");
              assert.equal((await decisionFor("WebSearch")).behavior, expectedWebSearch ? "allow" : "deny");

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
                assert.equal(curlDecision.behavior, expectedNetwork ? "allow" : "deny");
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
        sessionId: "s_perm",
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
        sessionId: `s_reasoning_${c.name}`,
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
    sessionId: "s_sandbox_scope",
    config: { workspace: { cwd: process.cwd() }, access: { auto: "medium", network: true, webSearch: true } },
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
      sessionId: "s_symlink_escape",
      config: { workspace: { cwd: workspaceDir }, access: { auto: "medium", network: true, webSearch: true } },
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

  const session = await runtime.openSession({ sessionId: "s_sources_default", config: { workspace: { cwd: process.cwd() } } });
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
    sessionId: "s_sources_empty",
    config: { workspace: { cwd: process.cwd() }, provider: { settingSources: [] } },
  });
  const run = await session.run({ input: { parts: [{ type: "text", text: "hello" }] } });

  for await (const _ev of run.events) {
    // drain
  }
});
