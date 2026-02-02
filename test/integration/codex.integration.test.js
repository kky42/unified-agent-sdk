import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createRuntime } from "@unified-agent-sdk/runtime";
const codexHome = process.env.TEST_CODEX_HOME || join(os.homedir(), ".codex");

test(
  "Codex integration: run completes",
  { timeout: 120_000 },
	  async () => {
	    const base = await mkdtemp(join(os.tmpdir(), "unified-agent-sdk-codex-itest-"));
	    const workspaceDir = join(base, "workspace");
	    await mkdir(workspaceDir, { recursive: true });

		    const runtime = createRuntime({
		      provider: "@openai/codex-sdk",
		      home: codexHome,
		      defaultOpts: {
		        workspace: { cwd: workspaceDir },
		        access: { auto: "low" },
		        model: process.env.CODEX_MODEL,
			      },
			    });

		    const session = await runtime.openSession({
		      config: { reasoningEffort: "low" },
		    });

    const run = await session.run({
      input: {
        parts: [
          {
            type: "text",
            text: "Say hello in one sentence. Do not use tools.",
          },
        ],
      },
    });

    let completed;
    for await (const ev of run.events) {
      if (ev.type === "run.completed") completed = ev;
    }

    assert.ok(completed, "expected run.completed event");
    assert.equal(completed.status, "success");
    assert.ok(typeof completed.finalText === "string" && completed.finalText.length > 0);

    await session.dispose();
    await runtime.close();
    await rm(base, { recursive: true, force: true });
  },
);

test(
  "Codex integration: structured output is parsed into run.completed.structuredOutput",
  { timeout: 120_000 },
	  async () => {
	    const base = await mkdtemp(join(os.tmpdir(), "unified-agent-sdk-codex-itest-"));
	    const workspaceDir = join(base, "workspace");
	    await mkdir(workspaceDir, { recursive: true });

		    const runtime = createRuntime({
		      provider: "@openai/codex-sdk",
		      home: codexHome,
		      defaultOpts: {
		        workspace: { cwd: workspaceDir },
		        access: { auto: "low" },
		        model: process.env.CODEX_MODEL,
			      },
			    });

		    const session = await runtime.openSession({
		      config: { reasoningEffort: "low" },
		    });

    const schema = {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          age: { type: "integer" },
          score: { type: "number" },
        },
        required: ["name", "age", "score"],
        additionalProperties: false,
      },
    };

    const run = await session.run({
      input: {
        parts: [
          {
            type: "text",
            text: [
              "Return JSON only.",
              "",
              "Extract the students as an array of objects with keys: name (string), age (integer), score (number).",
              "Preserve the order shown below.",
              "",
              "Students:",
              "- Ada, age 15, score 91",
              "- Ben, age 16, score 84",
              "- Cora, age 17, score 78",
            ].join("\n"),
          },
        ],
      },
      config: { outputSchema: schema },
    });

    let completed;
    for await (const ev of run.events) {
      if (ev.type === "run.completed") completed = ev;
    }

    assert.ok(completed, "expected run.completed event");
    assert.equal(completed.status, "success");
    assert.ok(Array.isArray(completed.structuredOutput), "expected structuredOutput to be an array");
    assert.deepEqual(completed.structuredOutput, [
      { name: "Ada", age: 15, score: 91 },
      { name: "Ben", age: 16, score: 84 },
      { name: "Cora", age: 17, score: 78 },
    ]);

    await session.dispose();
    await runtime.close();
    await rm(base, { recursive: true, force: true });
  },
);

test(
  "Codex integration: cancel aborts the run and reports cancelled status",
  { timeout: 120_000 },
  async () => {
	    const base = await mkdtemp(join(os.tmpdir(), "unified-agent-sdk-codex-itest-"));
	    const workspaceDir = join(base, "workspace");
	    await mkdir(workspaceDir, { recursive: true });

		    const runtime = createRuntime({
		      provider: "@openai/codex-sdk",
		      home: codexHome,
		      defaultOpts: {
		        workspace: { cwd: workspaceDir },
		        access: { auto: "low" },
		        model: process.env.CODEX_MODEL,
			      },
			    });

		    const session = await runtime.openSession({
		      config: { reasoningEffort: "low" },
		    });

    const run = await session.run({
      input: {
        parts: [
          {
            type: "text",
            text: "Write a very long essay about the history of computing. Include at least 10 paragraphs with detailed information about each era.",
          },
        ],
      },
    });

    let completed;
    let sawProviderActivity = false;
    let resolveProviderActivity;
    const providerActivity = new Promise((resolve) => {
      resolveProviderActivity = resolve;
    });

    const eventsTask = (async () => {
      for await (const ev of run.events) {
        // Codex adapter currently doesn't emit assistant deltas; use provider events as the
        // signal that the underlying Codex process has started producing events.
        if (!sawProviderActivity && ev.type === "provider.event") {
          sawProviderActivity = true;
          resolveProviderActivity();
        }
        if (ev.type === "run.completed") completed = ev;
      }
    })();

    // Give the run a chance to start before aborting.
    await Promise.race([providerActivity, new Promise((resolve) => setTimeout(resolve, 500))]);
    await session.cancel(run.runId);
    await eventsTask;

    assert.ok(completed, "expected run.completed event");
    assert.equal(completed.status, "cancelled", "expected status to be cancelled");

    await session.dispose();
	    await runtime.close();
	    await rm(base, { recursive: true, force: true });
	  },
	);

test(
  "Codex integration: usage normalization survives resumeSession",
  { timeout: 120_000 },
  async () => {
    const base = await mkdtemp(join(os.tmpdir(), "unified-agent-sdk-codex-itest-"));
    const workspaceDir = join(base, "workspace");
    await mkdir(workspaceDir, { recursive: true });

    const runtime1 = createRuntime({
      provider: "@openai/codex-sdk",
      home: codexHome,
      defaultOpts: {
        workspace: { cwd: workspaceDir },
        access: { auto: "low" },
        model: process.env.CODEX_MODEL,
      },
    });

    const session1 = await runtime1.openSession({
      config: { reasoningEffort: "low" },
    });

    const run1 = await session1.run({
      input: {
        parts: [
          {
            type: "text",
            text: "Say hello in one sentence. Do not use tools.",
          },
        ],
      },
    });

    let completed1;
    for await (const ev of run1.events) {
      if (ev.type === "run.completed") completed1 = ev;
    }
    assert.ok(completed1, "expected run.completed event for turn 1");
    assert.equal(completed1.status, "success");
    assert.ok(completed1.usage, "expected usage on turn 1");

    const handle = await session1.snapshot();
    await session1.dispose();
    await runtime1.close();

    const runtime2 = createRuntime({
      provider: "@openai/codex-sdk",
      home: codexHome,
      defaultOpts: {
        workspace: { cwd: workspaceDir },
        access: { auto: "low" },
        model: process.env.CODEX_MODEL,
      },
    });

    const session2 = await runtime2.resumeSession(handle);
    const run2 = await session2.run({
      input: {
        parts: [
          {
            type: "text",
            text: "Say hello again in one sentence. Do not use tools.",
          },
        ],
      },
    });

    let completed2;
    for await (const ev of run2.events) {
      if (ev.type === "run.completed") completed2 = ev;
    }
    assert.ok(completed2, "expected run.completed event for turn 2");
    assert.equal(completed2.status, "success");
    assert.ok(completed2.usage, "expected usage on turn 2");

    const raw1 = completed1.usage.raw;
    const raw2 = completed2.usage.raw;
    assert.ok(raw1 && typeof raw1 === "object", "expected raw usage object for turn 1");
    assert.ok(raw2 && typeof raw2 === "object", "expected raw usage object for turn 2");
    assert.ok(raw1.__cumulative && typeof raw1.__cumulative === "object", "expected raw.__cumulative for turn 1");
    assert.ok(raw2.__cumulative && typeof raw2.__cumulative === "object", "expected raw.__cumulative for turn 2");

    const c1 = raw1.__cumulative;
    const c2 = raw2.__cumulative;
    assert.equal(typeof c1.input_tokens, "number");
    assert.equal(typeof c1.cached_input_tokens, "number");
    assert.equal(typeof c1.output_tokens, "number");
    assert.equal(typeof c2.input_tokens, "number");
    assert.equal(typeof c2.cached_input_tokens, "number");
    assert.equal(typeof c2.output_tokens, "number");

    assert.equal(typeof completed2.usage.input_tokens, "number");
    assert.equal(typeof completed2.usage.cache_read_tokens, "number");
    assert.equal(typeof completed2.usage.output_tokens, "number");

    assert.equal(c2.input_tokens - c1.input_tokens, completed2.usage.input_tokens);
    assert.equal(c2.output_tokens - c1.output_tokens, completed2.usage.output_tokens);
    assert.equal(c2.cached_input_tokens - c1.cached_input_tokens, completed2.usage.cache_read_tokens);

    await session2.dispose();
    await runtime2.close();
    await rm(base, { recursive: true, force: true });
  },
);
