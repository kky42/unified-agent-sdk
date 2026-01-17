import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createRuntime } from "@unified-agent-sdk/runtime";
import { loadDotEnv } from "../helpers/load-env.mjs";

loadDotEnv();

const anthropicApiKey = process.env.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_AUTH_TOKEN;
assert.ok(anthropicApiKey, "Claude smoke tests require ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN.");

test("Claude smoke: run completes", { timeout: 120_000 }, async () => {
  const base = await mkdtemp(join(os.tmpdir(), "unified-agent-sdk-claude-smoke-"));
  const workspaceDir = join(base, "workspace");
  await mkdir(workspaceDir, { recursive: true });

  const runtime = createRuntime({
    provider: "@anthropic-ai/claude-agent-sdk",
    home: join(base, "claude"),
    env: {
      ANTHROPIC_API_KEY: anthropicApiKey,
      ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
    },
    defaultOpts: {
      workspace: { cwd: workspaceDir },
      access: { auto: "medium", network: false, webSearch: false },
      model: process.env.CLAUDE_MODEL,
    },
  });

  const session = await runtime.openSession({
    sessionId: `smoke-claude-${Date.now()}`,
    config: {
      provider: {
        systemPrompt: "You are a concise assistant.",
        stderr: (data) => process.stderr.write(data),
      },
    },
  });

  const run = await session.run({
    input: { parts: [{ type: "text", text: "Say hello in one sentence." }] },
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
