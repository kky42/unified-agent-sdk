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
		        access: { auto: "low", network: false, webSearch: false },
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
		        access: { auto: "low", network: false, webSearch: false },
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
		        access: { auto: "low", network: false, webSearch: false },
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
