import assert from "node:assert/strict";
import test from "node:test";

import { mergeSessionConfigWithDefaults } from "../../packages/runtime/dist/internal.js";

test("mergeSessionConfigWithDefaults merges default access with partial session access", () => {
  const defaults = { access: { network: false, webSearch: false } };
  const merged = mergeSessionConfigWithDefaults({ access: { network: false } }, defaults);

  assert.deepEqual(merged.access, { network: false, webSearch: false });
});

test("mergeSessionConfigWithDefaults lets session access override default access fields", () => {
  const defaults = { access: { auto: "low", network: false, webSearch: false } };
  const merged = mergeSessionConfigWithDefaults({ access: { auto: "high", network: true } }, defaults);

  assert.deepEqual(merged.access, { auto: "high", network: true, webSearch: false });
});

test("mergeSessionConfigWithDefaults applies default access when session access is omitted", () => {
  const defaults = { access: { auto: "medium", network: false, webSearch: true } };
  const merged = mergeSessionConfigWithDefaults(undefined, defaults);

  assert.deepEqual(merged.access, { auto: "medium", network: false, webSearch: true });
});

