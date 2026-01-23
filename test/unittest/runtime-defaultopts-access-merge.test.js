import assert from "node:assert/strict";
import test from "node:test";

import { mergeSessionConfigWithDefaults } from "../../packages/runtime/dist/internal.js";

test("mergeSessionConfigWithDefaults applies default access when session access is omitted", () => {
  const defaults = { access: { auto: "low" } };
  const merged = mergeSessionConfigWithDefaults(undefined, defaults);

  assert.deepEqual(merged.access, { auto: "low" });
});

test("mergeSessionConfigWithDefaults lets session access override default access", () => {
  const defaults = { access: { auto: "low" } };
  const merged = mergeSessionConfigWithDefaults({ access: { auto: "high" } }, defaults);

  assert.deepEqual(merged.access, { auto: "high" });
});

test("mergeSessionConfigWithDefaults drops legacy access flags", () => {
  const defaults = { access: { auto: "low" } };
  const merged = mergeSessionConfigWithDefaults({ access: { auto: "medium", network: false, webSearch: false } }, defaults);

  assert.deepEqual(merged.access, { auto: "medium" });
});
