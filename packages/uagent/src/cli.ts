import { createInterface } from "node:readline/promises";
import process from "node:process";
import { randomUUID } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { inspect } from "node:util";

import { createRuntime, type UnifiedSession } from "@unified-agent-sdk/runtime";

type ProviderFlag = "codex" | "claude";
type AutoLevel = "low" | "medium" | "high";
type ReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh";

const ANSI = {
  green: "\u001b[32m",
  orange: "\u001b[38;5;208m",
  reset: "\u001b[0m",
};

type ParsedArgs =
  | {
      mode: "help";
    }
  | {
      mode: "exec";
      provider: ProviderFlag;
      home?: string;
      workspace: string;
      addDirs?: string[];
      auto?: AutoLevel;
      model?: string;
      reasoningEffort?: ReasoningEffort;
      network?: boolean;
      webSearch?: boolean;
      verbose?: boolean;
      trace?: boolean;
      traceRaw?: boolean;
      prompt: string;
    }
  | {
      mode: "interactive";
      provider: ProviderFlag;
      home?: string;
      workspace: string;
      addDirs?: string[];
      auto?: AutoLevel;
      model?: string;
      reasoningEffort?: ReasoningEffort;
      network?: boolean;
      webSearch?: boolean;
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
      "  uagent <codex|claude> [--home <dir>] [--workspace <dir>] [--add-dir <dir>]...",
      "",
      "Workspace scope:",
      "  --workspace  Working directory root (default: cwd)",
      "  --add-dir    Additional writable root (repeatable)",
      "",
      "Access:",
      "  --auto <low|medium|high>   Access preset (default: medium)",
      "  --network[=true|false]  Outbound network (default: true)",
      "  --websearch[=true|false] Web search tool (default: true)",
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
    const valueFlags = new Set(["home", "workspace", "auto", "model", "reasoning-effort"]);
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

      if (name.startsWith("no-")) {
        const base = name.slice(3);
        if (base === "network" || base === "websearch") {
          flags.set(base, "false");
          continue;
        }
      }

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
        "network",
        "websearch",
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

    const network = parseBoolFlag(flags.get("network")) ?? true;
    const webSearch = parseBoolFlag(flags.get("websearch")) ?? true;
    const verbose = parseBoolFlag(flags.get("verbose")) ?? false;

    const traceRaw = parseBoolFlag(flags.get("trace-raw")) ?? false;
    const trace = (parseBoolFlag(flags.get("trace")) ?? false) || traceRaw;

    return {
      flags,
      positionals,
      home,
      workspace,
      addDirs,
      auto,
      model,
      reasoningEffort,
      network,
      webSearch,
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
    const parsed = parseWithStartIndex(isExec ? 2 : 1);
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
      network,
      webSearch,
      verbose,
      trace,
      traceRaw,
    } = parsed;

    // If the legacy --provider flag is also present, require it to match.
    const providerFlag = flags.get("provider");
    if (typeof providerFlag === "string" && providerFlag !== providerPos) return { mode: "help" };

    if (flags.get("add-dir") === true) return { mode: "help" };

    if (isExec) {
      const prompt = positionals.join(" ").trim();
      if (!prompt) return { mode: "help" };
      return {
        mode: "exec",
        provider: providerPos,
        home,
        workspace,
        addDirs,
        auto,
        model,
        reasoningEffort,
        network,
        webSearch,
        verbose,
        trace,
        traceRaw,
        prompt,
      };
    }

    return {
      mode: "interactive",
      provider: providerPos,
      home,
      workspace,
      addDirs,
      auto,
      model,
      reasoningEffort,
      network,
      webSearch,
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
): Promise<{ status: string }> {
  const handle = await session.run({ input: turnInput(prompt) });

  let atLineStart = true;
  let currentAnswerText = "";
  let printedAnyAgentHeader = false;
  let printedAnswer = false;
  let lastToolName: string | null = null;
  let block: "tools" | "reasoning" | "answer" | null = null;
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

  const printReasoningMarker = () => {
    ensureAgentHeader();
    if (!atLineStart) write("\n");
    write(`${ANSI.orange}Reasoning${ANSI.reset}\n`);
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

      if (opts.traceRaw && event.type === "provider.event") {
        process.stderr.write(
          `${inspect(event.payload, { depth: 8, maxArrayLength: 50, maxStringLength: 2000, compact: false })}\n`,
        );
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
      write(event.textDelta);
      currentAnswerText += event.textDelta;
      printedAnswer = true;
      continue;
    }

    if (event.type === "assistant.reasoning.delta") {
      // Intentionally suppress reasoning text in the TUI.
      continue;
    }

    if (event.type === "assistant.message") {
      writeAssistantText(event.message.text);
      continue;
    }

    if (event.type === "assistant.reasoning.message") {
      // Treat each reasoning message as a distinct reasoning block, but do not show its contents.
      const prevBlock = block as "tools" | "reasoning" | "answer" | null;
      if (prevBlock === "tools" && !atLineStart) write("\n");
      block = "reasoning";
      lastToolName = null;
      // Only print once per contiguous reasoning phase (similar grouping logic to tools).
      if (prevBlock !== "reasoning") printReasoningMarker();
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
  return { status: result.status };
}

async function openSession(
  provider: ProviderFlag,
  home: string | undefined,
  workspace: string,
  addDirs: string[] | undefined,
  access: { auto?: AutoLevel; network?: boolean; webSearch?: boolean } | undefined,
  model: string | undefined,
  reasoningEffort: ReasoningEffort | undefined,
) {
  const runtime = createRuntimeFor(provider, home);
  const cwd = resolve(workspace);
  const additionalDirs =
    addDirs && addDirs.length ? addDirs.map((d) => (isAbsolute(d) ? d : resolve(cwd, d))) : undefined;
  const session = await runtime.openSession({
    sessionId: randomUUID(),
    config: {
      workspace: { cwd, ...(additionalDirs ? { additionalDirs } : {}) },
      ...(model ? { model } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
      access: access ?? { auto: "medium", network: true, webSearch: true },
    },
  });
  return { runtime, session };
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.mode === "help") {
    printHelp();
    process.exitCode = 0;
    return;
  }

  const access = { auto: parsed.auto ?? "medium", network: parsed.network, webSearch: parsed.webSearch };

  if (parsed.mode === "exec") {
    const { runtime, session } = await openSession(
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
        const { status } = await runInteractiveTurn(session, parsed.prompt, { trace: parsed.trace, traceRaw: parsed.traceRaw });
        process.exitCode = status === "success" ? 0 : 1;
        if (status !== "success") process.stdout.write(`(run status: ${status})\n`);
      } else {
        const { status, finalText, lastErrorMessage } = await runOnce(session, parsed.prompt, { captureTools: false });
        process.stdout.write(finalText ? `${finalText}\n` : "");
        process.exitCode = status === "success" ? 0 : 1;
        if (status !== "success" && !finalText) {
          process.stderr.write(`[uagent] run failed (status=${status})${lastErrorMessage ? `: ${lastErrorMessage}` : ""}\n`);
        }
      }
    } finally {
      await session.dispose().catch(() => undefined);
      await runtime.close().catch(() => undefined);
    }
    return;
  }

  if (parsed.provider === "codex" && parsed.network && process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1") {
    process.stderr.write("[uagent] Warning: CODEX_SANDBOX_NETWORK_DISABLED=1 is set; Codex sandbox network may be blocked.\n");
  }

  const { runtime, session } = await openSession(
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

      const { status } = await runInteractiveTurn(session, prompt, { trace: parsed.trace, traceRaw: parsed.traceRaw });
      if (status !== "success") process.stdout.write(`(run status: ${status})\n`);
    }
  } finally {
    rl.close();
    await session.dispose().catch(() => undefined);
    await runtime.close().catch(() => undefined);
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.stack || err.message : String(err);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
