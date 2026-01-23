import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import process from "node:process";
import { dirname, isAbsolute, resolve } from "node:path";
import { inspect } from "node:util";

import {
  UNIFIED_AGENT_SDK_SESSION_HANDLE_METADATA_KEY,
  createRuntime,
  type SessionHandle,
  type UnifiedAgentSdkSessionHandleMetadataV1,
  type UnifiedSession,
  type UnifiedAgentSdkSessionConfigSnapshot,
} from "@unified-agent-sdk/runtime";

type ProviderFlag = "codex" | "claude";
type AutoLevel = "low" | "medium" | "high";
type ReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh";

const ANSI = {
  green: "\u001b[32m",
  orange: "\u001b[38;5;208m",
  dim: "\u001b[2m",
  reset: "\u001b[0m",
};

type ParsedArgs =
  | {
      mode: "help";
    }
  | {
      mode: "exec";
      provider: ProviderFlag;
      resumeHandle?: string;
      resumeOverrides?: {
        workspace?: string;
        addDirs?: string[];
        access?: { auto?: AutoLevel };
        model?: string;
        reasoningEffort?: ReasoningEffort;
      };
      home?: string;
      workspace: string;
      addDirs?: string[];
      auto?: AutoLevel;
      model?: string;
      reasoningEffort?: ReasoningEffort;
      dumpHandle?: string;
      verbose?: boolean;
      trace?: boolean;
      traceRaw?: boolean;
      prompt: string;
    }
  | {
      mode: "interactive";
      provider: ProviderFlag;
      resumeHandle?: string;
      resumeOverrides?: {
        workspace?: string;
        addDirs?: string[];
        access?: { auto?: AutoLevel };
        model?: string;
        reasoningEffort?: ReasoningEffort;
      };
      home?: string;
      workspace: string;
      addDirs?: string[];
      auto?: AutoLevel;
      model?: string;
      reasoningEffort?: ReasoningEffort;
      dumpHandle?: string;
      verbose?: boolean;
      trace?: boolean;
      traceRaw?: boolean;
    };

function printHelp(): void {
  process.stdout.write(
    [
      "uagent",
      "",
      "Usage:",
      "  uagent <codex|claude> exec [--home <dir>] [--workspace <dir>] [--add-dir <dir>]... \"prompt\"",
      "  uagent <codex|claude> resume --handle <file> [--workspace <dir>] [--add-dir <dir>]... \"prompt\"",
      "  uagent <codex|claude> [--home <dir>] [--workspace <dir>] [--add-dir <dir>]...",
      "  uagent <codex|claude> resume --handle <file> [--workspace <dir>] [--add-dir <dir>]...",
      "",
      "Resume:",
      "  --handle       JSON SessionHandle file from --dump-handle",
      "",
      "Workspace scope:",
      "  --workspace  Working directory root (default: cwd)",
      "  --add-dir    Additional writable root (repeatable)",
      "  --dump-handle  Write a JSON SessionHandle to this file",
      "",
      "Access:",
      "  --auto <low|medium|high>   Access preset (default: medium)",
      "",
      "Model & reasoning:",
      "  --model, -m <id>                     Model id (provider-specific)",
      "  --reasoning-effort, -r <none|low|medium|high|xhigh>  Reasoning effort preset (default: medium)",
      "",
      "Notes:",
      "  - Unknown flags show this help (to avoid silent typos).",
      "",
      "Debug:",
      "  --verbose   Print full agent steps in exec mode (tools/reasoning/stream)",
      "  --trace     Print unified runtime events to stderr",
      "  --trace-raw Print raw provider payloads (noisy; implies --trace)",
      "",
      "  - Interactive mode: type /exit to quit.",
      "",
    ].join("\n"),
  );
}

function parseBoolFlag(value: string | true | undefined): boolean | undefined {
  if (value === true) return true;
  if (typeof value !== "string") return undefined;
  const v = value.trim().toLowerCase();
  if (v === "true" || v === "1" || v === "yes" || v === "on") return true;
  if (v === "false" || v === "0" || v === "no" || v === "off") return false;
  return undefined;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = [...argv];
  if (args.includes("-h") || args.includes("--help")) return { mode: "help" };

  const parseWithStartIndex = (startIndex: number) => {
    const valueFlags = new Set(["home", "workspace", "auto", "model", "reasoning-effort", "handle", "dump-handle"]);
    const flags = new Map<string, string | true>();
    const positionals: string[] = [];
    const addDirs: string[] = [];
    const seenUnknownFlags: string[] = [];

	    for (let i = startIndex; i < args.length; i++) {
	      const token = args[i];
	      if (!token) continue;

	      // Short flags.
	      if (token.startsWith("-") && !token.startsWith("--")) {
	        const raw = token.slice(1);
	        const eq = raw.indexOf("=");
	        const short = eq === -1 ? raw : raw.slice(0, eq);
	        const inlineValue = eq === -1 ? undefined : raw.slice(eq + 1);

	        const name = short === "m" ? "model" : short === "r" ? "reasoning-effort" : null;
	        if (!name) {
	          seenUnknownFlags.push(short || token);
	          continue;
	        }

	        if (typeof inlineValue === "string" && inlineValue.length) {
	          flags.set(name, inlineValue);
	          continue;
	        }

	        const next = args[i + 1];
	        if (next && !next.startsWith("-")) {
	          flags.set(name, next);
	          i++;
	          continue;
	        }

	        // Missing required value.
	        flags.set(name, true);
	        continue;
	      }

	      if (!token.startsWith("--")) {
	        positionals.push(token);
	        continue;
	      }

      const raw = token.slice(2);
      const eq = raw.indexOf("=");
      const name = eq === -1 ? raw : raw.slice(0, eq);
      const inlineValue = eq === -1 ? undefined : raw.slice(eq + 1);

      if (name === "add-dir") {
        if (typeof inlineValue === "string" && inlineValue.length) {
          addDirs.push(inlineValue);
          continue;
        }
        const next = args[i + 1];
        if (next && !next.startsWith("--")) {
          addDirs.push(next);
          i++;
          continue;
        }
        // Missing required value.
        flags.set(name, true);
        continue;
      }

      const allowedBooleanFlags = new Set([
        "verbose",
        "trace",
        "trace-raw",
        // legacy compatibility: allow `--provider` but validate later
        "provider",
      ]);

      if (valueFlags.has(name)) {
        if (typeof inlineValue === "string" && inlineValue.length) {
          flags.set(name, inlineValue);
          continue;
        }
        const next = args[i + 1];
        if (next && !next.startsWith("--")) {
          flags.set(name, next);
          i++;
          continue;
        }
        // Missing required value (e.g. `--home` without a path).
        flags.set(name, true);
        continue;
      }

      // Boolean flags must NOT consume the next token (so they can appear right before the prompt).
      if (!allowedBooleanFlags.has(name)) {
        seenUnknownFlags.push(name);
        continue;
      }
      flags.set(name, inlineValue ?? true);
    }

    if (seenUnknownFlags.length) return { mode: "help" as const };

    const homeRaw = flags.get("home");
    const home = typeof homeRaw === "string" ? homeRaw : undefined;

    const workspaceRaw = flags.get("workspace");
    const workspace = typeof workspaceRaw === "string" ? workspaceRaw : process.cwd();

    const autoRaw = flags.get("auto");
    if (autoRaw === true) return { mode: "help" as const };
    const auto =
      typeof autoRaw === "string"
        ? (autoRaw.trim().toLowerCase() as AutoLevel)
        : undefined;
    if (auto !== undefined && auto !== "low" && auto !== "medium" && auto !== "high") return { mode: "help" as const };

    const modelRaw = flags.get("model");
    if (modelRaw === true) return { mode: "help" as const };
    const model = typeof modelRaw === "string" ? modelRaw.trim() : undefined;
    if (model !== undefined && !model) return { mode: "help" as const };

    const reasoningEffortRaw = flags.get("reasoning-effort");
    if (reasoningEffortRaw === true) return { mode: "help" as const };
    const reasoningEffort =
      typeof reasoningEffortRaw === "string"
        ? (reasoningEffortRaw.trim().toLowerCase() as ReasoningEffort)
        : undefined;
    if (
      reasoningEffort !== undefined &&
      reasoningEffort !== "none" &&
      reasoningEffort !== "low" &&
      reasoningEffort !== "medium" &&
      reasoningEffort !== "high" &&
      reasoningEffort !== "xhigh"
    ) {
      return { mode: "help" as const };
    }

      const verbose = parseBoolFlag(flags.get("verbose")) ?? false;

      const traceRaw = parseBoolFlag(flags.get("trace-raw")) ?? false;
      const trace = (parseBoolFlag(flags.get("trace")) ?? false) || traceRaw;

      const dumpHandleRaw = flags.get("dump-handle");
      if (dumpHandleRaw === true) return { mode: "help" as const };
      const dumpHandle = typeof dumpHandleRaw === "string" ? dumpHandleRaw.trim() : undefined;
      if (dumpHandle !== undefined && !dumpHandle) return { mode: "help" as const };

      const handleRaw = flags.get("handle");
      if (handleRaw === true) return { mode: "help" as const };
      const handle = typeof handleRaw === "string" ? handleRaw.trim() : undefined;
      if (handle !== undefined && !handle) return { mode: "help" as const };

    return {
      flags,
      positionals,
      home,
      workspace,
      addDirs,
      auto,
      model,
      reasoningEffort,
      dumpHandle,
      handle,
      verbose,
      trace,
      traceRaw,
    };
  };

  // Preferred syntax:
  //   uagent <provider> [exec] [flags] ...
  const providerPos = args[0];
  if (providerPos === "codex" || providerPos === "claude") {
    const command = args[1];
    const isExec = command === "exec";
    const isResume = command === "resume";
    const parsed = parseWithStartIndex(isExec || isResume ? 2 : 1);
    if ("mode" in parsed && parsed.mode === "help") return { mode: "help" };
    const {
      flags,
      positionals,
      home,
      workspace,
      addDirs,
      auto,
      model,
      reasoningEffort,
      dumpHandle,
      handle,
      verbose,
      trace,
      traceRaw,
    } = parsed;

    // If the legacy --provider flag is also present, require it to match.
    const providerFlag = flags.get("provider");
    if (typeof providerFlag === "string" && providerFlag !== providerPos) return { mode: "help" };

    if (flags.get("add-dir") === true) return { mode: "help" };

    if (isResume && !handle) return { mode: "help" };

    if (isExec || isResume) {
      const prompt = positionals.join(" ").trim();
      if (!prompt) return { mode: "help" };
      return {
        mode: "exec",
        provider: providerPos,
        ...(isResume
          ? {
              resumeHandle: handle,
              resumeOverrides: {
                ...(flags.has("workspace") ? { workspace } : {}),
                ...(addDirs.length ? { addDirs } : {}),
                ...(flags.has("auto") ? { access: { auto } } : {}),
                ...(flags.has("model") ? { model } : {}),
                ...(flags.has("reasoning-effort") ? { reasoningEffort } : {}),
              },
            }
          : {}),
        home,
        workspace,
        addDirs,
        auto,
        model,
        reasoningEffort,
        dumpHandle,
        verbose,
        trace,
        traceRaw,
        prompt,
      };
    }

    return {
      mode: "interactive",
      provider: providerPos,
      ...(isResume
        ? {
            resumeHandle: handle,
            resumeOverrides: {
              ...(flags.has("workspace") ? { workspace } : {}),
              ...(addDirs.length ? { addDirs } : {}),
              ...(flags.has("auto") ? { access: { auto } } : {}),
              ...(flags.has("model") ? { model } : {}),
              ...(flags.has("reasoning-effort") ? { reasoningEffort } : {}),
            },
          }
        : {}),
      home,
      workspace,
      addDirs,
      auto,
      model,
      reasoningEffort,
      dumpHandle,
      verbose,
      trace,
      traceRaw,
    };
  }
  return { mode: "help" };
}

function createRuntimeFor(provider: ProviderFlag, home?: string) {
  if (provider === "codex") return createRuntime({ provider: "@openai/codex-sdk", home: home ?? null });
  return createRuntime({ provider: "@anthropic-ai/claude-agent-sdk", home: home ?? null });
}

function turnInput(text: string) {
  return { parts: [{ type: "text" as const, text }] };
}

async function readSessionHandle(path: string): Promise<SessionHandle> {
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object") throw new Error(`Invalid SessionHandle JSON: ${path}`);
  return parsed as SessionHandle;
}

async function writeSessionHandle(path: string, handle: SessionHandle): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(handle, null, 2)}\n`, "utf8");
}

function readUnifiedSnapshotFromHandle(handle: SessionHandle): UnifiedAgentSdkSessionConfigSnapshot | undefined {
  const metadata = handle.metadata;
  if (!metadata || typeof metadata !== "object") return undefined;
  const raw = (metadata as Record<string, unknown>)[UNIFIED_AGENT_SDK_SESSION_HANDLE_METADATA_KEY];
  if (!raw || typeof raw !== "object") return undefined;

  const v1 = raw as Partial<UnifiedAgentSdkSessionHandleMetadataV1>;
  if (v1.version !== 1) return undefined;
  if (!v1.sessionConfig || typeof v1.sessionConfig !== "object") return undefined;

  const cfg = v1.sessionConfig as Record<string, unknown>;
  const out: UnifiedAgentSdkSessionConfigSnapshot = {};

  const workspace = cfg.workspace;
  if (workspace && typeof workspace === "object" && !Array.isArray(workspace)) {
    const cwd = (workspace as { cwd?: unknown }).cwd;
    const additionalDirs = (workspace as { additionalDirs?: unknown }).additionalDirs;
    const ws: UnifiedAgentSdkSessionConfigSnapshot["workspace"] = typeof cwd === "string" && cwd ? { cwd } : undefined;
    if (ws && Array.isArray(additionalDirs) && additionalDirs.every((d) => typeof d === "string" && d)) {
      ws.additionalDirs = additionalDirs;
    }
    if (ws) out.workspace = ws;
  }

  const access = cfg.access;
  if (access && typeof access === "object" && !Array.isArray(access)) {
    const auto = (access as { auto?: unknown }).auto;
    if (auto === "low" || auto === "medium" || auto === "high") out.access = { auto };
  }

  const model = cfg.model;
  if (typeof model === "string" && model.trim()) out.model = model.trim();

  const reasoningEffort = cfg.reasoningEffort;
  if (
    reasoningEffort === "none" ||
    reasoningEffort === "low" ||
    reasoningEffort === "medium" ||
    reasoningEffort === "high" ||
    reasoningEffort === "xhigh"
  ) {
    out.reasoningEffort = reasoningEffort;
  }

  return out;
}

function writeUnifiedSnapshotToHandle(
  handle: SessionHandle,
  snapshot: UnifiedAgentSdkSessionConfigSnapshot,
): SessionHandle {
  const metadata = (handle.metadata ??= {});
  metadata[UNIFIED_AGENT_SDK_SESSION_HANDLE_METADATA_KEY] = { version: 1, sessionConfig: snapshot } satisfies UnifiedAgentSdkSessionHandleMetadataV1;
  return handle;
}

async function runOnce(session: UnifiedSession, prompt: string, opts: { captureTools: boolean }) {
  const toolCalls: string[] = [];
  const handle = await session.run({ input: turnInput(prompt) });

  let streamedText = "";
  let finalText = "";
  let lastErrorMessage: string | undefined;
  for await (const event of handle.events) {
    if (event.type === "tool.call" && opts.captureTools) toolCalls.push(event.toolName);
    if (event.type === "assistant.delta") streamedText += event.textDelta;
    if (event.type === "assistant.message") finalText = event.message.text;
    if (event.type === "error") lastErrorMessage = event.message;
    if (event.type === "run.completed" && typeof event.finalText === "string") finalText = event.finalText;
  }

  const result = await handle.result;
  return { status: result.status, finalText: finalText || result.finalText || streamedText, toolCalls, lastErrorMessage };
}

async function runInteractiveTurn(
  session: UnifiedSession,
  prompt: string,
  opts: { trace?: boolean; traceRaw?: boolean },
): Promise<{ status: string; lastErrorMessage?: string }> {
  const handle = await session.run({ input: turnInput(prompt) });

  let atLineStart = true;
  let currentAnswerText = "";
  let printedAnyAgentHeader = false;
  let printedAnswer = false;
  let lastToolName: string | null = null;
  let block: "tools" | "reasoning" | "answer" | null = null;
  let reasoningOpen = false;
  let reasoningHasDelta = false;
  let lastErrorMessage: string | undefined;
  const toolNameByCallId = new Map<string, string>();

  const write = (text: string) => {
    if (text.length === 0) return;
    process.stdout.write(text);
    atLineStart = text.endsWith("\n");
  };

  const ensureAgentHeader = () => {
    if (printedAnyAgentHeader) return;
    if (!atLineStart) write("\n");
    write(`${ANSI.green}<Agent>${ANSI.reset}\n`);
    printedAnyAgentHeader = true;
  };

  const startToolsBlockIfNeeded = () => {
    ensureAgentHeader();
    if (block !== "tools") {
      if (!atLineStart) write("\n");
      block = "tools";
      lastToolName = null;
      reasoningOpen = false;
      reasoningHasDelta = false;
    }
  };

  const writeTool = (toolName: string) => {
    startToolsBlockIfNeeded();
    if (lastToolName === null) {
      write(`${ANSI.orange}${toolName}${ANSI.reset}`);
      lastToolName = toolName;
      return;
    }
    if (lastToolName === toolName) {
      write(`${ANSI.orange}, ${toolName}${ANSI.reset}`);
      return;
    }
    write(`\n${ANSI.orange}${toolName}${ANSI.reset}`);
    lastToolName = toolName;
  };

  const beginReasoningBlock = () => {
    if (reasoningOpen) return;
    ensureAgentHeader();
    if (!atLineStart) write("\n");
    block = "reasoning";
    lastToolName = null;
    reasoningOpen = true;
    write(`${ANSI.orange}Reasoning${ANSI.reset}\n`);
  };

  const writeReasoningText = (text: string) => {
    if (!text) return;
    write(`${ANSI.dim}${text}${ANSI.reset}`);
  };

  const writeAssistantText = (nextText: string) => {
    if (!nextText) return;
    ensureAgentHeader();
    if (block === "tools" && !atLineStart) write("\n");
    if (block !== "answer") {
      if (!atLineStart) write("\n");
      // Start of a new answer segment (often after tools).
      currentAnswerText = "";
    }
    block = "answer";
    lastToolName = null;
    reasoningOpen = false;
    reasoningHasDelta = false;
    printedAnswer = true;
    if (!currentAnswerText) {
      write(nextText);
      currentAnswerText = nextText;
      return;
    }

    if (nextText.length >= currentAnswerText.length && nextText.startsWith(currentAnswerText)) {
      const delta = nextText.slice(currentAnswerText.length);
      if (delta) {
        write(delta);
        currentAnswerText = nextText;
      }
      return;
    }

    // Fallback: treat as a new message segment.
    if (!atLineStart) write("\n");
    write(nextText);
    currentAnswerText = nextText;
  };

  ensureAgentHeader();

  for await (const event of handle.events) {
    if (opts.trace) {
      const detailParts: string[] = [];
      if (event.type === "tool.call") {
        detailParts.push(`toolName=${event.toolName}`);
      } else if (event.type === "assistant.delta") {
        detailParts.push(`len=${event.textDelta.length}`);
      } else if (event.type === "assistant.reasoning.delta") {
        detailParts.push(`len=${event.textDelta.length}`);
      } else if (event.type === "provider.event") {
        const payload = event.payload as any;
        if (payload && typeof payload === "object") {
          if (typeof payload.type === "string") detailParts.push(`payload.type=${payload.type}`);
          if (payload.item && typeof payload.item === "object") {
            if (typeof payload.item.type === "string") detailParts.push(`item.type=${payload.item.type}`);
            if (typeof payload.item.id === "string") detailParts.push(`item.id=${payload.item.id}`);
          }
        }
      }

      const detail = detailParts.length ? ` ${detailParts.join(" ")}` : "";
      process.stderr.write(`[uagent] ${event.type}${detail}\n`);

      if (opts.traceRaw) {
        const rawPayload = event.type === "provider.event" ? event.payload : event.raw;
        if (rawPayload !== undefined) {
          const rawLabel = event.type === "provider.event" ? "provider.event" : `${event.type}.raw`;
          process.stderr.write(`[uagent] ${rawLabel}\n`);
          process.stderr.write(
            `${inspect(rawPayload, { depth: 8, maxArrayLength: 50, maxStringLength: 2000, compact: false })}\n`,
          );
        }
      }
    }

    if (event.type === "tool.call") {
      writeTool(event.toolName);
      toolNameByCallId.set(event.callId, event.toolName);
      toolNameByCallId.set(`printed:${event.callId}`, event.toolName);
      continue;
    }

    if (event.type === "tool.result") {
      const toolName = toolNameByCallId.get(event.callId);
      if (toolName && !toolNameByCallId.has(`printed:${event.callId}`)) {
        writeTool(toolName);
        toolNameByCallId.set(`printed:${event.callId}`, toolName);
      }
      continue;
    }

    if (event.type === "assistant.delta") {
      ensureAgentHeader();
      const currentBlock = block as "tools" | "reasoning" | "answer" | null;
      if (currentBlock === "tools" && !atLineStart) write("\n");
      if (currentBlock !== "answer") {
        if (!atLineStart) write("\n");
        // Start of a new streamed answer segment.
        currentAnswerText = "";
      }
      block = "answer";
      lastToolName = null;
      reasoningOpen = false;
      reasoningHasDelta = false;
      write(event.textDelta);
      currentAnswerText += event.textDelta;
      printedAnswer = true;
      continue;
    }

    if (event.type === "assistant.reasoning.delta") {
      beginReasoningBlock();
      reasoningHasDelta = true;
      writeReasoningText(event.textDelta);
      continue;
    }

    if (event.type === "assistant.message") {
      writeAssistantText(event.message.text);
      continue;
    }

    if (event.type === "error") {
      lastErrorMessage = event.message;
      continue;
    }

    if (event.type === "assistant.reasoning.message") {
      beginReasoningBlock();
      if (!reasoningHasDelta) writeReasoningText(event.message.text);
      reasoningOpen = false;
      reasoningHasDelta = false;
      continue;
    }

    if (event.type === "run.completed") {
      // Avoid duplicating provider `assistant.message` output (common for Claude).
      if (!printedAnswer && typeof event.finalText === "string" && event.finalText) writeAssistantText(event.finalText);
    }
  }

  const result = await handle.result;
  if ((block as "tools" | "reasoning" | "answer" | null) === "tools" && !atLineStart) write("\n");
  if (!atLineStart) write("\n");
  return { status: result.status, lastErrorMessage };
}

async function openSession(
  provider: ProviderFlag,
  home: string | undefined,
  workspace: string,
  addDirs: string[] | undefined,
  access: { auto?: AutoLevel } | undefined,
  model: string | undefined,
  reasoningEffort: ReasoningEffort | undefined,
) {
  const runtime = createRuntimeFor(provider, home);
  const cwd = resolve(workspace);
  const additionalDirs =
    addDirs && addDirs.length ? addDirs.map((d) => (isAbsolute(d) ? d : resolve(cwd, d))) : undefined;
  const session = await runtime.openSession({
    config: {
      workspace: { cwd, ...(additionalDirs ? { additionalDirs } : {}) },
      ...(model ? { model } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
      access: access ?? { auto: "medium" },
    },
  });
  return { runtime, session };
}

async function resumeSessionFromHandleFile(
  provider: ProviderFlag,
  home: string | undefined,
  handleFile: string,
  opts: {
    workspace?: string;
    addDirs?: string[];
    access?: { auto?: AutoLevel };
    model?: string;
    reasoningEffort?: ReasoningEffort;
  },
) {
  const runtime = createRuntimeFor(provider, home);
  const handle = await readSessionHandle(handleFile);
  if (handle.provider && handle.provider !== runtime.provider) {
    throw new Error(`SessionHandle provider mismatch: handle=${handle.provider} runtime=${runtime.provider}`);
  }
  if (!handle.sessionId) {
    throw new Error(`SessionHandle is missing sessionId (cannot resume): ${handleFile}`);
  }

  const existing = readUnifiedSnapshotFromHandle(handle);

  const next: UnifiedAgentSdkSessionConfigSnapshot = existing ? { ...existing } : {};
  let changed = false;

  const workspaceOverride = opts.workspace ? resolve(opts.workspace) : undefined;
  const baseCwd = workspaceOverride ?? existing?.workspace?.cwd ?? process.cwd();
  const baseCwdAbs = resolve(baseCwd);
  const additionalDirsOverride =
    opts.addDirs && opts.addDirs.length
      ? opts.addDirs.map((d) => (isAbsolute(d) ? d : resolve(baseCwdAbs, d)))
      : undefined;

  if (workspaceOverride !== undefined || additionalDirsOverride !== undefined) {
    const existingWorkspace = next.workspace;
    const cwd = workspaceOverride ?? existingWorkspace?.cwd ?? baseCwdAbs;
    next.workspace = {
      cwd,
      ...(existingWorkspace?.additionalDirs ? { additionalDirs: existingWorkspace.additionalDirs } : {}),
      ...(additionalDirsOverride !== undefined ? { additionalDirs: additionalDirsOverride } : {}),
    };
    changed = true;
  }

  if (opts.access) {
    next.access = {
      ...(next.access ?? {}),
      ...(opts.access.auto !== undefined ? { auto: opts.access.auto } : {}),
    };
    changed = true;
  }

  if (opts.model !== undefined) {
    next.model = opts.model;
    changed = true;
  }
  if (opts.reasoningEffort !== undefined) {
    next.reasoningEffort = opts.reasoningEffort;
    changed = true;
  }

  if (existing || changed) writeUnifiedSnapshotToHandle(handle, next);
  const session = await runtime.resumeSession(handle);
  return { runtime, session };
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.mode === "help") {
    printHelp();
    process.exitCode = 0;
    return;
  }

  if (parsed.mode === "exec") {
    if (parsed.provider === "codex" && (parsed.auto ?? "medium") !== "high" && process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1") {
      process.stderr.write("[uagent] Warning: CODEX_SANDBOX_NETWORK_DISABLED=1 is set; Codex sandbox network may be blocked.\n");
    }
    const access = { auto: parsed.auto ?? "medium" };
    const { runtime, session } = parsed.resumeHandle
      ? await resumeSessionFromHandleFile(parsed.provider, parsed.home, parsed.resumeHandle, parsed.resumeOverrides ?? {})
      : await openSession(
          parsed.provider,
          parsed.home,
          parsed.workspace,
          parsed.addDirs,
          access,
          parsed.model,
          parsed.reasoningEffort,
        );
    try {
      if (parsed.verbose) {
        const { status, lastErrorMessage } = await runInteractiveTurn(session, parsed.prompt, {
          trace: parsed.trace,
          traceRaw: parsed.traceRaw,
        });
        if (session.sessionId) process.stderr.write(`[uagent] sessionId=${session.sessionId}\n`);
        process.exitCode = status === "success" ? 0 : 1;
        if (status !== "success") {
          process.stdout.write(`(run status: ${status})\n`);
          if (lastErrorMessage) process.stderr.write(`[uagent] run failed (status=${status}): ${lastErrorMessage}\n`);
        }
      } else {
        const { status, finalText, lastErrorMessage } = await runOnce(session, parsed.prompt, { captureTools: false });
        process.stdout.write(finalText ? `${finalText}\n` : "");
        if (session.sessionId) process.stderr.write(`[uagent] sessionId=${session.sessionId}\n`);
        process.exitCode = status === "success" ? 0 : 1;
        if (status !== "success") {
          process.stderr.write(`[uagent] run failed (status=${status})${lastErrorMessage ? `: ${lastErrorMessage}` : ""}\n`);
        }
      }

      if (parsed.dumpHandle) {
        const handle = await session.snapshot();
        await writeSessionHandle(parsed.dumpHandle, handle);
        process.stderr.write(`[uagent] wrote SessionHandle to ${parsed.dumpHandle}\n`);
      }
    } finally {
      await session.dispose().catch(() => undefined);
      await runtime.close().catch(() => undefined);
    }
    return;
  }

  if (parsed.provider === "codex") {
    if ((parsed.auto ?? "medium") !== "high" && process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1") {
      process.stderr.write("[uagent] Warning: CODEX_SANDBOX_NETWORK_DISABLED=1 is set; Codex sandbox network may be blocked.\n");
    }
  }

  const access = { auto: parsed.auto ?? "medium" };

  const { runtime, session } = parsed.resumeHandle
    ? await resumeSessionFromHandleFile(parsed.provider, parsed.home, parsed.resumeHandle, parsed.resumeOverrides ?? {})
    : await openSession(
        parsed.provider,
        parsed.home,
        parsed.workspace,
        parsed.addDirs,
        access,
        parsed.model,
        parsed.reasoningEffort,
      );
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    while (true) {
      const line = await rl.question(`${ANSI.green}<User>${ANSI.reset}\n`);
      const prompt = line.trimEnd();
      if (!prompt) continue;
      if (prompt === "/exit" || prompt === "/quit") break;

      const { status, lastErrorMessage } = await runInteractiveTurn(session, prompt, {
        trace: parsed.trace,
        traceRaw: parsed.traceRaw,
      });
      if (session.sessionId) process.stderr.write(`[uagent] sessionId=${session.sessionId}\n`);
      if (status !== "success") {
        process.stdout.write(`(run status: ${status})\n`);
        if (lastErrorMessage) process.stderr.write(`[uagent] run failed (status=${status}): ${lastErrorMessage}\n`);
      }
    }
  } finally {
    rl.close();
    if (parsed.dumpHandle) {
      const handle = await session.snapshot();
      await writeSessionHandle(parsed.dumpHandle, handle);
      process.stderr.write(`[uagent] wrote SessionHandle to ${parsed.dumpHandle}\n`);
    }
    await session.dispose().catch(() => undefined);
    await runtime.close().catch(() => undefined);
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.stack || err.message : String(err);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
