import { spawn } from "node:child_process";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";

const REPO_ROOT = process.cwd();
const UA = path.join(REPO_ROOT, "packages/uagent/bin/uagent.js");

const BASE_ROOT =
  process.env.TEST_BASE_ROOT ?? path.join(REPO_ROOT, ".cache", "test");

const CODEX_HOME =
  process.env.CODEX_HOME ??
  path.join(REPO_ROOT, ".profiles", "codex", "yescode");
const CLAUDE_HOME =
  process.env.CLAUDE_HOME ??
  path.join(REPO_ROOT, ".profiles", "claude", "minimax");

const DEFAULTS_BY_PROVIDER = {
  codex: { model: "gpt-5.2", reasoningEffort: "low" },
  claude: { model: "haiku", reasoningEffort: "low" },
};

const AUTOS = ["low", "medium", "high"];

const ANSI_RE = /\u001b\[[0-9;]*m/g;

function nowId() {
  // Local-ish, filesystem friendly.
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(
    d.getHours(),
  )}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

async function exec(cmd, args, { cwd, env } = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function stripAnsi(s) {
  return s.replaceAll(ANSI_RE, "");
}

function lastMatch(text, re) {
  let m;
  let last = null;
  while ((m = re.exec(text))) last = m;
  return last;
}

async function findFileByBasename(dir, basename) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const ent of entries) {
    const p = path.join(dir, ent.name);
    if (ent.isFile() && ent.name === basename) return p;
    if (ent.isDirectory()) {
      const found = await findFileByBasename(p, basename);
      if (found) return found;
    }
  }
  return null;
}

async function fileExists(p) {
  try {
    const info = await stat(p);
    return info.isFile();
  } catch {
    return false;
  }
}

async function runUagent({
  provider,
  home,
  workspace,
  addDirs,
  auto,
  prompt,
  logPath,
}) {
  const { model, reasoningEffort } = DEFAULTS_BY_PROVIDER[provider];

  const args = [
    UA,
    provider,
    "exec",
    "--home",
    home,
    "--workspace",
    workspace,
    "--auto",
    auto,
    "--model",
    model,
    "--reasoning-effort",
    reasoningEffort,
    "--verbose",
  ];

  for (const d of addDirs ?? []) args.push("--add-dir", d);

  args.push(prompt);

  const res = await exec("node", args, { cwd: REPO_ROOT });
  const combined = `${res.stdout}${res.stderr ? `\n${res.stderr}` : ""}`;
  await writeFile(logPath, combined, "utf8");
  return { ...res, combined };
}

async function startLocalHttpServer() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok\n");
  });
  await new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("Failed to bind local HTTP server.");
  return { server, port: addr.port };
}

async function writeMatrix(runDir) {
  const results = {
    runDir,
    date: new Date().toISOString(),
    providers: {},
  };

  const local = await startLocalHttpServer();
  const localLoopbackUrl = `http://127.0.0.1:${local.port}/`;
  const localLocalhostUrl = `http://localhost:${local.port}/`;

  const providers = [
    { provider: "codex", home: CODEX_HOME },
    { provider: "claude", home: CLAUDE_HOME },
  ];

  try {
    for (const { provider, home } of providers) {
      const providerDir = path.join(runDir, provider);
      await mkdir(providerDir, { recursive: true });

      const readResults = [];
      const writeResults = [];
      const netResults = [];

      // Read behavior matrix: auto x target.
      for (const auto of AUTOS) {
        for (const target of ["workspace", "add", "outside"]) {
          const caseDir = path.join(providerDir, "read", `auto-${auto}`, target);
          const workspace = path.join(caseDir, "workspace");
          const add = path.join(caseDir, "add");
          const outside = path.join(caseDir, "outside");
          await mkdir(workspace, { recursive: true });
          await mkdir(add, { recursive: true });
          await mkdir(outside, { recursive: true });

          const marker = `READ_${provider}_${auto}_${target}_${nowId()}`;
          const fileName = `${marker}.txt`;
          const targetPath =
            target === "workspace"
              ? path.join(workspace, fileName)
              : target === "add"
                ? path.join(add, fileName)
                : path.join(outside, fileName);

          // Seed the file for the agent to read (outside of the agent sandbox).
          await writeFile(targetPath, `${marker}\n`, "utf8");

          const addDirs = target === "add" ? [add] : [];
          const prompt =
            `Do NOT guess. You MUST attempt the read using Bash before answering.\\n` +
            `IMPORTANT: Do NOT try to force /bin/bash or override the shell. Just run the command in the Bash tool.\\n` +
            `\\n` +
            `Step 1 (read): Use Bash to run:\\n` +
            `cat '${targetPath}'\\n` +
            `\\n` +
            `Step 2 (report): Output EXACTLY one line:\\n` +
            `READ=<the first line of stdout from step 1 OR READ_DENIED>\\n`;

          let usedBash = false;
          let read = { status: "unknown" };

          for (let attempt = 1; attempt <= 3; attempt += 1) {
            const logPath = path.join(caseDir, attempt === 1 ? "run.log" : `run.${attempt}.log`);
            const { combined } = await runUagent({
              provider,
              home,
              workspace,
              addDirs,
              auto,
              prompt,
              logPath,
            });

            const cleaned = stripAnsi(combined);
            const readLine = lastMatch(cleaned, /^READ=(.*)$/gm)?.[1]?.trim();

            const toolLines = cleaned
              .split("\n")
              .map((l) => l.trim())
              .filter((l) => /^[A-Za-z]+(, [A-Za-z]+)*$/.test(l));
            const toolsJoined = toolLines.join(" ");
            usedBash = /\bBash\b/.test(toolsJoined);

            read =
              typeof readLine !== "string" || !readLine
                ? { status: "unknown" }
                : readLine === "READ_DENIED"
                  ? { status: "denied" }
                  : readLine === marker && usedBash
                    ? { status: "ok" }
                    : { status: "mismatch", detail: readLine };

            if (read.status === "ok" || read.status === "denied") break;
          }

          readResults.push({ provider, auto, target, workspace, addDirs, targetPath, usedBash, read });
        }
      }

      // Write behavior matrix: auto x target.
      for (const auto of AUTOS) {
        for (const target of ["workspace", "add", "outside"]) {
          const caseDir = path.join(providerDir, "write", `auto-${auto}`, target);
          const workspace = path.join(caseDir, "workspace");
          const add = path.join(caseDir, "add");
          const outside = path.join(caseDir, "outside");
          await mkdir(workspace, { recursive: true });
          await mkdir(add, { recursive: true });
          await mkdir(outside, { recursive: true });

          const marker = `WRITE_${provider}_${auto}_${target}_${nowId()}`;
          const fileName = `${marker}.txt`;
          const targetPath =
            target === "workspace"
              ? path.join(workspace, fileName)
              : target === "add"
                ? path.join(add, fileName)
                : path.join(outside, fileName);

          const addDirs = target === "add" ? [add] : [];

          const prompt =
            `Use Bash to run exactly this command:\\n` +
            `printf '${marker}' > '${targetPath}'\\n` +
            `If the command succeeds, reply with exactly: WRITE_OK\\n` +
            `If the command is blocked, reply with exactly: WRITE_DENIED`;

          const logPath = path.join(caseDir, "run.log");
          await runUagent({
            provider,
            home,
            workspace,
            addDirs,
            auto,
            prompt,
            logPath,
          });

          const okAtTarget = await fileExists(targetPath);
          const redirected = okAtTarget ? null : await findFileByBasename(caseDir, fileName);

          writeResults.push({
            provider,
            auto,
            target,
            workspace,
            addDirs,
            targetPath,
            okAtTarget,
            redirectedPath: redirected,
          });
        }
      }

      // Network + web search: auto x (loopback curl + WebSearch tool).
      for (const auto of AUTOS) {
        const caseDir = path.join(providerDir, "net-web", `auto-${auto}`);
        const workspace = path.join(caseDir, "workspace");
        await mkdir(workspace, { recursive: true });

        const prompt =
          `Do NOT guess. You MUST attempt ALL steps using tools before answering.\\n` +
          `\\n` +
          `Step 1 (curl loopback): Use Bash to run:\\n` +
          `curl -sI '${localLoopbackUrl}' || echo CURL_LOOPBACK_FAILED\\n` +
          `Then output: LOOPBACK=<first line of stdout from step 1 OR CURL_LOOPBACK_DENIED OR CURL_LOOPBACK_FAILED>\\n` +
          `\\n` +
          `Step 2 (curl localhost): Use Bash to run:\\n` +
          `curl -4 -sI '${localLocalhostUrl}' || echo CURL_LOCALHOST_FAILED\\n` +
          `Then output: LOCALHOST=<first line of stdout from step 2 OR CURL_LOCALHOST_DENIED OR CURL_LOCALHOST_FAILED>\\n` +
          `\\n` +
          `Step 3 (web search): Attempt to call the WebSearch tool (do NOT use WebFetch) to search for:\\n` +
          `example.com example domain\\n` +
          `Then output: WEBSEARCH=<OK OR DENIED>\\n` +
          `\\n` +
          `Final answer: output EXACTLY 3 lines:\\n` +
          `LOOPBACK=...\\n` +
          `LOCALHOST=...\\n` +
          `WEBSEARCH=...`;

        const logPath = path.join(caseDir, "run.log");
        const { combined } = await runUagent({
          provider,
          home,
          workspace,
          addDirs: [],
          auto,
          prompt,
          logPath,
        });

        const cleaned = stripAnsi(combined);
        const loopbackLine = lastMatch(cleaned, /^LOOPBACK=(.*)$/gm)?.[1]?.trim();
        const localhostLine = lastMatch(cleaned, /^LOCALHOST=(.*)$/gm)?.[1]?.trim();
        const webLine = lastMatch(cleaned, /^WEBSEARCH=(.*)$/gm)?.[1]?.trim();

        const toolLines = cleaned
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => /^[A-Za-z]+(, [A-Za-z]+)*$/.test(l));
        const toolsJoined = toolLines.join(" ");
        const usedWebSearch = /\bWebSearch\b/.test(toolsJoined);

        const classifyCurl = (line, failedToken, deniedToken) => {
          if (typeof line !== "string" || !line) return { status: "unknown" };
          if (line === deniedToken) return { status: "denied" };
          if (line === failedToken) return { status: "failed" };
          if (line.startsWith("HTTP/")) return { status: "ok", detail: line };
          return { status: "unknown", detail: line };
        };

        netResults.push({
          provider,
          auto,
          loopback: classifyCurl(loopbackLine, "CURL_LOOPBACK_FAILED", "CURL_LOOPBACK_DENIED"),
          localhost: classifyCurl(localhostLine, "CURL_LOCALHOST_FAILED", "CURL_LOCALHOST_DENIED"),
          web:
            typeof webLine !== "string" || !webLine
              ? { status: "unknown" }
              : webLine === "DENIED"
                ? { status: "denied" }
                : webLine === "OK"
                  ? usedWebSearch
                    ? { status: "ok" }
                    : { status: "mismatch", detail: "Model claimed OK without WebSearch tool usage." }
                  : { status: "unknown", detail: webLine },
        });
      }

      results.providers[provider] = { readResults, writeResults, netResults };
    }
  } finally {
    local.server.close();
  }

  await writeFile(
    path.join(runDir, "results.json"),
    `${JSON.stringify(results, null, 2)}\n`,
    "utf8",
  );
  return results;
}

async function main() {
  const runDir = path.join(BASE_ROOT, `permission-e2e-${nowId()}`);
  await mkdir(runDir, { recursive: true });
  const results = await writeMatrix(runDir);
  process.stdout.write(`Wrote results to ${path.join(runDir, "results.json")}\n`);
  process.stdout.write(JSON.stringify({ runDir: results.runDir }, null, 2) + "\n");
}

main().catch((err) => {
  process.stderr.write(`${err?.stack || err}\n`);
  process.exitCode = 1;
});
