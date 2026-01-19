import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";

test("AGENTS.md referenced repo paths exist", () => {
  const agentsPath = path.join(process.cwd(), "AGENTS.md");
  const content = fs.readFileSync(agentsPath, "utf8");

  const codeSpans = [...content.matchAll(/`([^`]+)`/g)].map((m) => m[1]).filter(Boolean);
  const referencedRepoPaths = codeSpans.filter(
    (v) =>
      v.startsWith("docs/") ||
      v.startsWith("packages/") ||
      v.startsWith("test/") ||
      v.startsWith("scripts/"),
  );

  const missing = [];
  for (const p of new Set(referencedRepoPaths)) {
    const resolved = path.join(process.cwd(), p);
    if (!fs.existsSync(resolved)) missing.push(p);
  }

  assert.equal(
    missing.length,
    0,
    missing.length ? `Missing paths referenced by AGENTS.md: ${missing.join(", ")}` : undefined,
  );
});
