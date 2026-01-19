import assert from "node:assert/strict";
import test from "node:test";

import { UNIFIED_AGENT_SDK_SESSION_HANDLE_METADATA_KEY } from "@unified-agent-sdk/runtime-core";
import { mergeSessionHandleWithDefaults } from "../../packages/runtime/dist/internal.js";

test("mergeSessionHandleWithDefaults adds unified session config metadata from defaults", () => {
  const handle = { provider: "@openai/codex-sdk", sessionId: "t1" };
  const merged = mergeSessionHandleWithDefaults(handle, {
    workspace: { cwd: "/repo", additionalDirs: ["/extra"] },
    access: { auto: "low", network: false, webSearch: false },
    model: "gpt-5",
    reasoningEffort: "high",
  });

  assert.ok(merged.metadata, "expected metadata to be set");
  const entry = merged.metadata[UNIFIED_AGENT_SDK_SESSION_HANDLE_METADATA_KEY];
  assert.ok(entry && typeof entry === "object", "expected unified metadata entry");

  assert.equal(entry.version, 1);
  assert.deepEqual(entry.sessionConfig, {
    workspace: { cwd: "/repo", additionalDirs: ["/extra"] },
    access: { auto: "low", network: false, webSearch: false },
    model: "gpt-5",
    reasoningEffort: "high",
  });
});

test("mergeSessionHandleWithDefaults merges default access with existing access", () => {
  const handle = {
    provider: "@openai/codex-sdk",
    sessionId: "t2",
    metadata: {
      [UNIFIED_AGENT_SDK_SESSION_HANDLE_METADATA_KEY]: {
        version: 1,
        sessionConfig: { access: { network: false } },
      },
      other: "preserved",
    },
  };

  const merged = mergeSessionHandleWithDefaults(handle, {
    access: { auto: "medium", network: true, webSearch: false },
  });

  assert.equal(merged.metadata.other, "preserved");
  const entry = merged.metadata[UNIFIED_AGENT_SDK_SESSION_HANDLE_METADATA_KEY];
  assert.equal(entry.version, 1);
  assert.deepEqual(entry.sessionConfig.access, { auto: "medium", network: false, webSearch: false });
});

