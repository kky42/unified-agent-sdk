import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";

import { createRuntime } from "@unified-agent-sdk/runtime";

const claudeHome = process.env.TEST_CLAUDE_HOME || join(os.homedir(), ".claude");

function formatUsage(usage) {
  if (!usage) return "usage=<none>";
  return `in=${usage.input_tokens ?? "?"} cache_read=${usage.cache_read_tokens ?? "?"} cache_write=${
    usage.cache_write_tokens ?? "?"
  } out=${usage.output_tokens ?? "?"} total=${usage.total_tokens ?? "?"} ctx=${usage.context_length ?? "?"}`;
}

async function setupChallengeWorkspace(workspaceDir) {
  // Ensure ESM for .js files (tests use import).
  await writeFile(join(workspaceDir, "package.json"), JSON.stringify({ private: true, type: "module" }, null, 2) + "\n", "utf8");

  const root = join(workspaceDir, "challenges");
  await mkdir(root, { recursive: true });

  // 01: duration parsing (bug: "ms" parsed as minutes)
  await mkdir(join(root, "01-duration"), { recursive: true });
  await writeFile(
    join(root, "01-duration", "parseDuration.js"),
    `export function parseDuration(input) {
  if (typeof input !== "string") throw new TypeError("duration must be a string");
  const s = input.trim().toLowerCase().replace(/\\s+/g, "");
  if (!s) throw new Error("duration is empty");

  const re = /(\\d+(?:\\.\\d+)?)([a-z]+)/g;
  let totalMs = 0;
  let consumed = 0;

  for (const match of s.matchAll(re)) {
    const value = Number(match[1]);
    const unit = match[2];
    consumed += match[0].length;

    let mult;
    // BUG: "ms" is treated as minutes because we only look at the first character.
    if (unit.startsWith("d")) mult = 24 * 60 * 60 * 1000;
    else if (unit.startsWith("h")) mult = 60 * 60 * 1000;
    else if (unit.startsWith("m")) mult = 60 * 1000;
    else if (unit.startsWith("s")) mult = 1000;
    else throw new Error(\`unknown unit: \${unit}\`);

    totalMs += value * mult;
  }

  if (consumed !== s.length) {
    throw new Error(\`invalid duration: \${input}\`);
  }

  return Math.round(totalMs);
}
`,
    "utf8",
  );
  await writeFile(
    join(root, "01-duration", "parseDuration.test.js"),
    `import assert from "node:assert/strict";
import test from "node:test";
import { parseDuration } from "./parseDuration.js";

test("parseDuration supports ms/s/m/h/d", () => {
  assert.equal(parseDuration("500ms"), 500);
  assert.equal(parseDuration("2s"), 2_000);
  assert.equal(parseDuration("3m"), 180_000);
  assert.equal(parseDuration("1h"), 3_600_000);
  assert.equal(parseDuration("1d"), 86_400_000);
});

test("parseDuration supports mixed units and whitespace", () => {
  assert.equal(parseDuration("1m500ms"), 60_500);
  assert.equal(parseDuration("2m 30s"), 150_000);
  assert.equal(parseDuration("1.5h"), 5_400_000);
});
`,
    "utf8",
  );

  // 02: LRU cache (bug: get() does not update recency)
  await mkdir(join(root, "02-lru"), { recursive: true });
  await writeFile(
    join(root, "02-lru", "lru.js"),
    `export class LRUCache {
  constructor({ max }) {
    if (!Number.isInteger(max) || max <= 0) throw new Error("max must be a positive integer");
    this.max = max;
    this.map = new Map();
  }

  get size() {
    return this.map.size;
  }

  has(key) {
    return this.map.has(key);
  }

  get(key) {
    // BUG: does not update recency
    return this.map.get(key);
  }

  set(key, value) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);

    while (this.map.size > this.max) {
      const oldestKey = this.map.keys().next().value;
      this.map.delete(oldestKey);
    }
  }
}
`,
    "utf8",
  );
  await writeFile(
    join(root, "02-lru", "lru.test.js"),
    `import assert from "node:assert/strict";
import test from "node:test";
import { LRUCache } from "./lru.js";

test("LRU eviction respects recency on get()", () => {
  const c = new LRUCache({ max: 2 });
  c.set("a", 1);
  c.set("b", 2);
  assert.equal(c.get("a"), 1);
  c.set("c", 3);
  assert.equal(c.has("a"), true);
  assert.equal(c.has("b"), false);
  assert.equal(c.has("c"), true);
});

test("LRU set() of existing key updates value and recency", () => {
  const c = new LRUCache({ max: 2 });
  c.set("a", 1);
  c.set("b", 2);
  c.set("a", 10);
  c.set("c", 3);
  assert.equal(c.has("a"), true);
  assert.equal(c.get("a"), 10);
  assert.equal(c.has("b"), false);
});
`,
    "utf8",
  );

  // 03: CSV row parser (bug: escaped quotes "" not handled)
  await mkdir(join(root, "03-csv"), { recursive: true });
  await writeFile(
    join(root, "03-csv", "parseCsvRow.js"),
    `export function parseCsvRow(line) {
  if (typeof line !== "string") throw new TypeError("line must be a string");
  const out = [];
  let cur = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      // BUG: doesn't handle escaped quotes ("") inside quoted field
      inQuotes = !inQuotes;
      continue;
    }
    if (ch === "," && !inQuotes) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }

  out.push(cur);
  return out;
}
`,
    "utf8",
  );
  await writeFile(
    join(root, "03-csv", "parseCsvRow.test.js"),
    `import assert from "node:assert/strict";
import test from "node:test";
import { parseCsvRow } from "./parseCsvRow.js";

test("parseCsvRow parses simple rows", () => {
  assert.deepEqual(parseCsvRow("a,b,c"), ["a", "b", "c"]);
  assert.deepEqual(parseCsvRow("a,,c"), ["a", "", "c"]);
});

test("parseCsvRow handles commas inside quotes", () => {
  assert.deepEqual(parseCsvRow('"a,b",c'), ["a,b", "c"]);
});

test("parseCsvRow handles escaped quotes inside quotes", () => {
  assert.deepEqual(parseCsvRow('"a\"\"b",c'), ['a"b', "c"]);
});
`,
    "utf8",
  );

  // 04: stable topo sort (bug: queue order not kept stable when new nodes become available)
  await mkdir(join(root, "04-toposort"), { recursive: true });
  await writeFile(
    join(root, "04-toposort", "toposort.js"),
    `export function topoSort(nodes, edges) {
  const index = new Map(nodes.map((n, i) => [n, i]));
  const indegree = new Map(nodes.map((n) => [n, 0]));
  const adj = new Map(nodes.map((n) => [n, []]));

  for (const [from, to] of edges) {
    if (!adj.has(from)) adj.set(from, []);
    adj.get(from).push(to);
    indegree.set(to, (indegree.get(to) ?? 0) + 1);
    if (!indegree.has(from)) indegree.set(from, 0);
  }

  const queue = nodes
    .filter((n) => (indegree.get(n) ?? 0) === 0)
    .sort((a, b) => index.get(a) - index.get(b));
  const out = [];

  while (queue.length) {
    const n = queue.shift();
    out.push(n);
    for (const m of adj.get(n) ?? []) {
      indegree.set(m, indegree.get(m) - 1);
      if (indegree.get(m) === 0) {
        // BUG: pushing unsorted breaks stable ordering
        queue.push(m);
      }
    }
  }

  if (out.length !== nodes.length) throw new Error("cycle detected");
  return out;
}
`,
    "utf8",
  );
  await writeFile(
    join(root, "04-toposort", "toposort.test.js"),
    `import assert from "node:assert/strict";
import test from "node:test";
import { topoSort } from "./toposort.js";

test("topoSort is stable by original node order", () => {
  const nodes = ["a", "b", "c", "d"];
  const edges = [
    ["a", "c"],
    ["b", "c"],
  ];
  assert.deepEqual(topoSort(nodes, edges), ["a", "b", "c", "d"]);
});

test("topoSort throws on cycles", () => {
  const nodes = ["a", "b"];
  const edges = [
    ["a", "b"],
    ["b", "a"],
  ];
  assert.throws(() => topoSort(nodes, edges), /cycle/i);
});
`,
    "utf8",
  );
}

async function runOne(session, prompt) {
  const run = await session.run({ input: { parts: [{ type: "text", text: prompt }] } });

  let completed;
  const toolCalls = [];

  for await (const ev of run.events) {
    if (ev.type === "tool.call") toolCalls.push(ev.toolName);
    if (ev.type === "run.completed") completed = ev;
  }

  if (!completed) throw new Error("Missing run.completed event");
  return { completed, toolCalls };
}

const base = await mkdtemp(join(os.tmpdir(), "unified-agent-sdk-claude-token-usage-"));
const workspaceDir = join(base, "workspace");
await mkdir(workspaceDir, { recursive: true });
await setupChallengeWorkspace(workspaceDir);

const runtime = createRuntime({
  provider: "@anthropic-ai/claude-agent-sdk",
  home: claudeHome,
  defaultOpts: {
    workspace: { cwd: workspaceDir },
    // Allow edits + test runs inside the temp workspace.
    access: { auto: "medium" },
    model: process.env.CLAUDE_MODEL,
  },
});

const session = await runtime.openSession({ config: { reasoningEffort: "low" } });

const problems = [
  {
    id: "01",
    title: "Fix ms parsing in parseDuration",
    prompt: [
      "You are working in a temp workspace.",
      "",
      "Task: Fix the bug in `challenges/01-duration/parseDuration.js` so all tests pass.",
      "",
      "Rules:",
      "- Use tools (shell + file edits).",
      "- Run the tests BEFORE changes and AFTER changes using:",
      "  `node --test challenges/01-duration/parseDuration.test.js`",
      "- Do not modify the test file.",
      "- Keep the patch minimal.",
      "",
      "In your final response, include the final `node --test ...` output (passing).",
    ].join("\n"),
  },
  {
    id: "02",
    title: "Fix LRU recency update on get()",
    prompt: [
      "Task: Fix the bug in `challenges/02-lru/lru.js` so all tests pass.",
      "",
      "Rules:",
      "- Use tools (shell + file edits).",
      "- Run the tests BEFORE changes and AFTER changes using:",
      "  `node --test challenges/02-lru/lru.test.js`",
      "- Do not modify the test file.",
      "- Keep the patch minimal and idiomatic.",
      "",
      "In your final response, include the final `node --test ...` output (passing).",
    ].join("\n"),
  },
  {
    id: "03",
    title: "Fix escaped quotes handling in CSV row parser",
    prompt: [
      "Task: Fix the bug in `challenges/03-csv/parseCsvRow.js` so all tests pass.",
      "",
      "Rules:",
      "- Use tools (shell + file edits).",
      "- Run the tests BEFORE changes and AFTER changes using:",
      "  `node --test challenges/03-csv/parseCsvRow.test.js`",
      "- Do not modify the test file.",
      "- Keep the patch minimal; no dependencies.",
      "",
      "In your final response, include the final `node --test ...` output (passing).",
    ].join("\n"),
  },
  {
    id: "04",
    title: "Make topoSort stable by original order",
    prompt: [
      "Task: Fix the bug in `challenges/04-toposort/toposort.js` so all tests pass.",
      "",
      "Definition of stable:",
      "- When multiple nodes are available, always pick the one that appears earliest in the `nodes` array.",
      "",
      "Rules:",
      "- Use tools (shell + file edits).",
      "- Run the tests BEFORE changes and AFTER changes using:",
      "  `node --test challenges/04-toposort/toposort.test.js`",
      "- Do not modify the test file.",
      "- Keep the patch minimal.",
      "",
      "In your final response, include the final `node --test ...` output (passing).",
    ].join("\n"),
  },
];

const results = [];

try {
  for (const p of problems) {
    console.log(`\n=== Problem ${p.id}: ${p.title} ===\n`);
    const { completed, toolCalls } = await runOne(session, p.prompt);

    const usage = completed.usage;

    const toolNames = toolCalls.reduce((acc, name) => {
      acc[name] = (acc[name] ?? 0) + 1;
      return acc;
    }, {});

    results.push({
      problem: p.id,
      title: p.title,
      status: completed.status,
      toolCalls: toolCalls.length,
      toolNames,
      usage,
    });

    console.log(`status=${completed.status} tools=${toolCalls.length} ${formatUsage(usage)}`);
  }
} finally {
  await session.dispose();
  await runtime.close();
}

console.log("\n=== Token usage summary (per turn) ===");
console.table(
  results.map((r) => ({
    problem: r.problem,
    status: r.status,
    toolCalls: r.toolCalls,
    input: r.usage?.input_tokens,
    cacheRead: r.usage?.cache_read_tokens,
    cacheWrite: r.usage?.cache_write_tokens,
    output: r.usage?.output_tokens,
    total: r.usage?.total_tokens,
    contextLength: r.usage?.context_length,
  })),
);

console.log("\n=== Full JSON ===");
console.log(JSON.stringify({ workspaceDir, results }, null, 2));

if (process.env.KEEP_CLAUDE_TOKEN_WORKSPACE === "1") {
  console.log(`\nKeeping workspace: ${workspaceDir}`);
} else {
  await rm(base, { recursive: true, force: true });
}

