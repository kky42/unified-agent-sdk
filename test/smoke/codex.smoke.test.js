import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createRuntime } from "@unified-agent-sdk/runtime";
const codexHome = process.env.TEST_CODEX_HOME || join(os.homedir(), ".codex");

test("Codex smoke: run completes", { timeout: 120_000 }, async () => {
  const base = await mkdtemp(join(os.tmpdir(), "unified-agent-sdk-codex-smoke-"));
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
    input: { parts: [{ type: "text", text: "Say hello in one sentence. Do not use tools." }] },
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
});
