import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";

import { createRuntime } from "@unified-agent-sdk/runtime";

const CODEX_HOME = process.env.TEST_CODEX_HOME || join(os.homedir(), ".codex");
const CLAUDE_HOME = process.env.TEST_CLAUDE_HOME || join(os.homedir(), ".claude");

function parseArgs(argv) {
  const out = { provider: "both", problem: "01" };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith("--provider=")) out.provider = arg.slice("--provider=".length);
    if (arg.startsWith("--problem=")) out.problem = arg.slice("--problem=".length);
  }
  if (!["codex", "claude", "both"].includes(out.provider)) {
    throw new Error(`Invalid --provider=${out.provider} (expected codex|claude|both)`);
  }
  if (!["01", "02", "03", "04"].includes(out.problem)) {
    throw new Error(`Invalid --problem=${out.problem} (expected 01|02|03|04)`);
  }
  return out;
}

function toIsoDateDir(date) {
  const yyyy = String(date.getFullYear());
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return { yyyy, mm, dd };
}

async function tryFindCodexSessionLogPath(codexHome, threadId) {
  const sessionsDir = join(codexHome, "sessions");
  const now = new Date();
  const offsets = [0, -1, 1];

  for (const off of offsets) {
    const d = new Date(now.getTime() + off * 24 * 60 * 60 * 1000);
    const { yyyy, mm, dd } = toIsoDateDir(d);
    const dayDir = join(sessionsDir, yyyy, mm, dd);
    try {
      const entries = await readdir(dayDir);
      const file = entries.find((name) => name.includes(threadId) && name.endsWith(".jsonl"));
      if (file) return join(dayDir, file);
    } catch {
      // ignore
    }
  }

  // Fallback: limited recursive search under sessionsDir.
  const stack = [sessionsDir];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile() && e.name.includes(threadId) && e.name.endsWith(".jsonl")) return p;
    }
  }

  return null;
}

async function readJsonl(path) {
  const text = await readFile(path, "utf8");
  const lines = text.split(/\n/).filter((l) => l.trim());
  return lines.map((l) => JSON.parse(l));
}

function extractCodexInternalTokenCounts(entries, startMs, endMs) {
  const out = [];
  for (const e of entries) {
    if (e?.type !== "event_msg") continue;
    if (e?.payload?.type !== "token_count") continue;

    const atMs = Date.parse(e.timestamp);
    if (!Number.isFinite(atMs)) continue;
    if (atMs < startMs || atMs > endMs) continue;

    const info = e.payload.info;
    if (!info || typeof info !== "object") continue;

    const last = info.last_token_usage;
    const total = info.total_token_usage;
    if (!last || typeof last !== "object") continue;

    out.push({
      atMs,
      last: {
        input_tokens: last.input_tokens,
        cached_input_tokens: last.cached_input_tokens,
        output_tokens: last.output_tokens,
        reasoning_output_tokens: last.reasoning_output_tokens,
        total_tokens: last.total_tokens,
      },
      total: total && typeof total === "object" ? total : null,
    });
  }
  return out;
}

function extractClaudeInternalUsageFromProviderEvent(ev) {
  if (!ev || ev.type !== "provider.event") return null;
  const msg = ev.payload;
  if (!msg || typeof msg !== "object") return null;
  if (msg.type !== "stream_event") return null;

  const raw = msg.event;
  if (!raw || typeof raw !== "object") return null;
  if (raw.type !== "message_delta") return null;
  if (!raw.usage || typeof raw.usage !== "object") return null;

  // Anthropic usage fields (best-effort).
  const u = raw.usage;
  const inputTokens = typeof u.input_tokens === "number" ? u.input_tokens : undefined;
  const outputTokens = typeof u.output_tokens === "number" ? u.output_tokens : undefined;
  const cacheRead = typeof u.cache_read_input_tokens === "number" ? u.cache_read_input_tokens : undefined;
  const cacheWrite = typeof u.cache_creation_input_tokens === "number" ? u.cache_creation_input_tokens : undefined;

  const hasAnyInput = inputTokens !== undefined || cacheRead !== undefined || cacheWrite !== undefined;
  const unifiedInput = hasAnyInput ? (inputTokens ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0) : undefined;
  const unifiedTotal =
    unifiedInput !== undefined || outputTokens !== undefined ? (unifiedInput ?? 0) + (outputTokens ?? 0) : undefined;

  return {
    atMs: ev.atMs,
    raw: u,
    unified: {
      input_tokens: unifiedInput,
      cache_read_tokens: cacheRead,
      cache_write_tokens: cacheWrite,
      output_tokens: outputTokens,
      total_tokens: unifiedTotal,
    },
  };
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
  assert.deepEqual(parseCsvRow('"a""b",c'), ['a"b', "c"]);
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

function buildProblemPrompt(problemId) {
  const defs = {
    "01": {
      file: "challenges/01-duration/parseDuration.js",
      test: "node --test challenges/01-duration/parseDuration.test.js",
    },
    "02": {
      file: "challenges/02-lru/lru.js",
      test: "node --test challenges/02-lru/lru.test.js",
    },
    "03": {
      file: "challenges/03-csv/parseCsvRow.js",
      test: "node --test challenges/03-csv/parseCsvRow.test.js",
    },
    "04": {
      file: "challenges/04-toposort/toposort.js",
      test: "node --test challenges/04-toposort/toposort.test.js",
    },
  };
  const d = defs[problemId];
  return [
    "You are working in a temp workspace.",
    "",
    `Task: Fix the bug in \`${d.file}\` so all tests pass.`,
    "",
    "Rules:",
    "- Use tools (shell + file edits).",
    "- Run the tests BEFORE changes and AFTER changes using:",
    `  \`${d.test}\``,
    "- Do not modify the test file.",
    "- Keep the patch minimal.",
    "",
    "In your final response, include the final test output (passing).",
  ].join("\n");
}

async function runProvider({ provider, home, workspaceDir, prompt }) {
  const runtime = createRuntime({
    provider,
    home,
    defaultOpts: {
      workspace: { cwd: workspaceDir },
      access: { auto: "medium" },
      model: provider === "@openai/codex-sdk" ? process.env.CODEX_MODEL : process.env.CLAUDE_MODEL,
    },
  });

  const session = await runtime.openSession({ config: { reasoningEffort: "low" } });
  const run = await session.run({ input: { parts: [{ type: "text", text: prompt }] } });

  let startedAtMs;
  let endedAtMs;
  let completed;
  const internal = [];

  for await (const ev of run.events) {
    if (ev.type === "run.started") startedAtMs = ev.atMs;
    if (provider === "@anthropic-ai/claude-agent-sdk") {
      const u = extractClaudeInternalUsageFromProviderEvent(ev);
      if (u) internal.push(u);
    }
    if (ev.type === "run.completed") {
      endedAtMs = ev.atMs;
      completed = ev;
    }
  }

  const sessionId = session.sessionId;
  await session.dispose();
  await runtime.close();

  return { completed, startedAtMs, endedAtMs, sessionId, internal };
}

const { provider, problem } = parseArgs(process.argv);

const base = await mkdtemp(join(os.tmpdir(), "uagent-internal-usage-"));
const workspaceDir = join(base, "workspace");
await mkdir(workspaceDir, { recursive: true });
await setupChallengeWorkspace(workspaceDir);

const prompt = buildProblemPrompt(problem);

try {
  if (provider === "codex" || provider === "both") {
    console.log("\n=== Codex (internal usage via CODEX_HOME session log) ===\n");
    const r = await runProvider({ provider: "@openai/codex-sdk", home: CODEX_HOME, workspaceDir, prompt });
    console.log("run.completed.usage", r.completed?.usage);
    console.log("sessionId", r.sessionId);

    if (r.sessionId && typeof r.startedAtMs === "number" && typeof r.endedAtMs === "number") {
      const logPath = await tryFindCodexSessionLogPath(CODEX_HOME, r.sessionId);
      console.log("sessionLog", logPath ?? "<not found>");
      if (logPath) {
        const entries = await readJsonl(logPath);
        const tokenCounts = extractCodexInternalTokenCounts(entries, r.startedAtMs - 1_000, r.endedAtMs + 2_000);
        console.log(`internal model calls (token_count): ${tokenCounts.length}`);
        console.table(
          tokenCounts.map((e, i) => ({
            i,
            at: new Date(e.atMs).toISOString(),
            in: e.last.input_tokens,
            cachedIn: e.last.cached_input_tokens,
            out: e.last.output_tokens,
            reasoningOut: e.last.reasoning_output_tokens,
            total: e.last.total_tokens,
          })),
        );
      }
    }
  }

  if (provider === "claude" || provider === "both") {
    console.log("\n=== Claude (internal usage via stream_event message_delta.usage) ===\n");
    const r = await runProvider({ provider: "@anthropic-ai/claude-agent-sdk", home: CLAUDE_HOME, workspaceDir, prompt });
    console.log("run.completed.usage", r.completed?.usage);
    console.log("run.completed.usage.context_length", r.completed?.usage?.context_length);
    console.log(`internal model calls (message_delta usage snapshots): ${r.internal.length}`);
    console.table(
      r.internal.map((e, i) => ({
        i,
        at: new Date(e.atMs).toISOString(),
        in: e.unified.input_tokens,
        cacheRead: e.unified.cache_read_tokens,
        cacheWrite: e.unified.cache_write_tokens,
        out: e.unified.output_tokens,
        total: e.unified.total_tokens,
      })),
    );
  }
} finally {
  await rm(base, { recursive: true, force: true });
}
