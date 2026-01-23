import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createRuntime } from "@unified-agent-sdk/runtime";
const claudeHome = process.env.TEST_CLAUDE_HOME || join(os.homedir(), ".claude");

test(
  "Claude integration: run completes",
  { timeout: 120_000 },
	  async () => {
	    const base = await mkdtemp(join(os.tmpdir(), "unified-agent-sdk-claude-itest-"));
	    const workspaceDir = join(base, "workspace");
	    await mkdir(workspaceDir, { recursive: true });

	    const runtime = createRuntime({
	      provider: "@anthropic-ai/claude-agent-sdk",
	      home: claudeHome,
	      defaultOpts: {
	        workspace: { cwd: workspaceDir },
	        access: { auto: "low" },
	        model: process.env.CLAUDE_MODEL,
		      }
		    });

	    const session = await runtime.openSession({});

    const run = await session.run({
      input: {
        parts: [
          {
            type: "text",
            text: "Say hello in one sentence.",
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
  "Claude integration: structured output is returned as run.completed.structuredOutput",
  { timeout: 120_000 },
	  async () => {
	    const base = await mkdtemp(join(os.tmpdir(), "unified-agent-sdk-claude-itest-"));
	    const workspaceDir = join(base, "workspace");
	    await mkdir(workspaceDir, { recursive: true });

	    const runtime = createRuntime({
	      provider: "@anthropic-ai/claude-agent-sdk",
	      home: claudeHome,
	      defaultOpts: {
	        workspace: { cwd: workspaceDir },
	        access: { auto: "low" },
	        model: process.env.CLAUDE_MODEL,
		      }
		    });

	    const session = await runtime.openSession({});

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
      config: { outputSchema: schema, provider: { maxTurns: 3 } },
    });

    let completed;
    for await (const ev of run.events) {
      if (ev.type === "run.completed") completed = ev;
    }

    assert.ok(completed, "expected run.completed event");
    const rawSubtype =
      completed.raw && typeof completed.raw === "object" && "subtype" in completed.raw ? completed.raw.subtype : undefined;
    const rawErrors =
      completed.raw && typeof completed.raw === "object" && "errors" in completed.raw ? completed.raw.errors : undefined;
    assert.equal(
      completed.status,
      "success",
      `Claude structured output failed (status=${completed.status}, rawSubtype=${String(rawSubtype)}, rawErrors=${JSON.stringify(rawErrors)})`,
    );
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
  "Claude integration: cancel aborts the run and reports cancelled status",
  { timeout: 120_000 },
  async () => {
	    const base = await mkdtemp(join(os.tmpdir(), "unified-agent-sdk-claude-itest-"));
	    const workspaceDir = join(base, "workspace");
	    await mkdir(workspaceDir, { recursive: true });

	    const runtime = createRuntime({
	      provider: "@anthropic-ai/claude-agent-sdk",
	      home: claudeHome,
	      defaultOpts: {
	        workspace: { cwd: workspaceDir },
	        access: { auto: "low" },
	        model: process.env.CLAUDE_MODEL,
		      }
		    });

	    const session = await runtime.openSession({});

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
    let sawActivity = false;
    let resolveActivity;
    const activity = new Promise((resolve) => {
      resolveActivity = resolve;
    });

    const eventsTask = (async () => {
      for await (const ev of run.events) {
        if (!sawActivity && ev.type !== "run.started") {
          sawActivity = true;
          resolveActivity();
        }
        if (ev.type === "run.completed") completed = ev;
      }
    })();

    // Give the run a chance to start producing events before aborting.
    await Promise.race([activity, new Promise((resolve) => setTimeout(resolve, 500))]);
    await session.cancel(run.runId);
    await eventsTask;

    assert.ok(completed, "expected run.completed event");
    assert.equal(completed.status, "cancelled", `expected status to be 'cancelled', got '${completed.status}'`);

    await session.dispose();
	    await runtime.close();
	    await rm(base, { recursive: true, force: true });
	  },
		);
