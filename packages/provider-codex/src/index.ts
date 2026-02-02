import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Codex, type CodexOptions, type Thread, type ThreadEvent, type ThreadOptions } from "@openai/codex-sdk";
import type {
  AccessConfig,
  ProviderId,
  ReasoningEffort,
  RunHandle,
  RunRequest,
  RuntimeCapabilities,
  RuntimeEvent,
  SessionConfig,
  SessionHandle,
  SessionStatus,
  UnifiedAgentSdkSessionConfigSnapshot,
  UnifiedAgentSdkSessionHandleMetadataV1,
  UnifiedAgentRuntime,
  UnifiedSession,
  UUID,
  WorkspaceConfig,
} from "@unified-agent-sdk/runtime-core";
import { SessionBusyError, UNIFIED_AGENT_SDK_SESSION_HANDLE_METADATA_KEY } from "@unified-agent-sdk/runtime-core";
import { AsyncEventStream, normalizeStructuredOutputSchema } from "@unified-agent-sdk/runtime-core/internal";

export const PROVIDER_CODEX_SDK = "@openai/codex-sdk" as ProviderId;
const CODEX_WORKSPACE_PATCH_APPLIED_TOOL_NAME = "WorkspacePatchApplied";
const UNIFIED_AGENT_SDK_CODEX_USAGE_METADATA_KEY = "unifiedAgentSdkCodexUsage";

/**
 * Tracks cumulative token usage across a Codex session.
 * Codex SDK reports cumulative totals on each turn.completed event,
 * so we need to compute per-turn deltas.
 */
interface CumulativeUsage {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
}

interface CodexUsageMetadataV1 {
  version: 1;
  cumulativeUsage: CumulativeUsage;
}

/**
 * Computes per-turn usage delta from cumulative values.
 * Handles session resets (when cumulative values decrease).
 */
function computeUsageDelta(
  current: CumulativeUsage,
  prev: CumulativeUsage | null,
): { delta: CumulativeUsage; wasReset: boolean } {
  if (prev === null) {
    return { delta: { ...current }, wasReset: false };
  }

  const wasReset =
    current.input_tokens < prev.input_tokens ||
    current.output_tokens < prev.output_tokens;

  if (wasReset) {
    return { delta: { ...current }, wasReset: true };
  }

  return {
    delta: {
      input_tokens: current.input_tokens - prev.input_tokens,
      cached_input_tokens: current.cached_input_tokens - prev.cached_input_tokens,
      output_tokens: current.output_tokens - prev.output_tokens,
    },
    wasReset: false,
  };
}

type UnifiedOwnedCodexKeys = "workingDirectory" | "additionalDirectories" | "model" | "modelReasoningEffort";
export type CodexSessionConfig = Omit<ThreadOptions, UnifiedOwnedCodexKeys>;

export type CodexRuntimeConfig = {
  /**
   * Client-level Codex SDK options (apiKey/baseUrl/env/codexPathOverride).
   * This matches the upstream `new Codex(options)` constructor.
   */
  client?: CodexOptions;
  /** Defaults applied to every thread created/resumed by this runtime. */
  defaults?: ThreadOptions;
  /** Dependency injection for tests/advanced usage. */
  codex?: Codex;
  /**
   * Deprecated alias (kept for compatibility within this repo's early development).
   * Prefer `client`.
   */
  codexOptions?: CodexOptions;
};

export class CodexRuntime implements UnifiedAgentRuntime<CodexSessionConfig, never> {
  public readonly provider = PROVIDER_CODEX_SDK;
  private readonly codex: Codex;
  private readonly defaults?: ThreadOptions;
  private readonly codexHome: string;

  constructor(config: CodexRuntimeConfig = {}) {
    const client = config.client ?? config.codexOptions;
    this.codex = config.codex ?? new Codex(client);
    this.defaults = config.defaults;
    this.codexHome = resolveCodexHome(client);
  }

  async capabilities(): Promise<RuntimeCapabilities> {
    return {
      streamingOutput: true,
      structuredOutput: true,
      reasoningEvents: "best_effort",
      cancel: true,
      sessionResume: true,
      toolEvents: true,
      rawEvents: true,
    };
  }

  async openSession(init: {
    config?: SessionConfig<CodexSessionConfig>;
  }): Promise<UnifiedSession<CodexSessionConfig, never>> {
    const provider: CodexSessionConfig = init.config?.provider ?? {};
    const access = normalizeAccess(init.config?.access);
    const accessOptions = mapUnifiedAccessToCodex(access);
    const model = init.config?.model;
    const reasoningEffort = init.config?.reasoningEffort ?? "medium";
    const threadOptions: ThreadOptions = {
      ...(this.defaults ?? {}),
      ...provider,
      ...(model ? { model } : {}),
      ...(init.config?.workspace && {
        workingDirectory: init.config.workspace.cwd,
        additionalDirectories: init.config.workspace.additionalDirs,
      }),
      ...accessOptions,
      modelReasoningEffort: mapReasoningEffortToCodex(reasoningEffort),
    };
    const thread = this.codex.startThread(threadOptions);
    return new CodexSession({
      thread,
      codexHome: this.codexHome,
      snapshotConfig: { workspace: init.config?.workspace, access, model, reasoningEffort },
    });
  }

  async resumeSession(handle: SessionHandle): Promise<UnifiedSession<CodexSessionConfig, never>> {
    if (!handle.sessionId) {
      throw new Error("Codex resumeSession requires sessionId (thread id).");
    }
    const restored = readUnifiedAgentSdkSessionConfig(handle);
    const prevCumulativeUsage = readCodexUsageMetadata(handle);
    const access = normalizeAccess(restored?.access);
    const accessOptions = mapUnifiedAccessToCodex(access);
    const model = restored?.model;
    const reasoningEffort = restored?.reasoningEffort ?? "medium";

    const threadOptions: ThreadOptions = {
      ...(this.defaults ?? {}),
      ...(model ? { model } : {}),
      ...(restored?.workspace && { workingDirectory: restored.workspace.cwd, additionalDirectories: restored.workspace.additionalDirs }),
      ...accessOptions,
      modelReasoningEffort: mapReasoningEffortToCodex(reasoningEffort),
    };

    const thread = this.codex.resumeThread(handle.sessionId, threadOptions);
    return new CodexSession({
      sessionId: handle.sessionId,
      thread,
      baseMetadata: handle.metadata,
      codexHome: this.codexHome,
      prevCumulativeUsage,
      snapshotConfig: { workspace: restored?.workspace, access, model, reasoningEffort },
    });
  }

  async close(): Promise<void> {}
}

class CodexSession implements UnifiedSession<CodexSessionConfig, never> {
  public readonly provider = PROVIDER_CODEX_SDK;
  public sessionId?: string;

  private readonly thread: Thread;
  private readonly codexHome: string;
  private readonly snapshotConfig: UnifiedAgentSdkSessionConfigSnapshot;
  private readonly baseMetadata?: Record<string, unknown>;
  private activeRunId: UUID | undefined;
  private readonly abortControllers = new Map<UUID, AbortController>();
  private readonly lastAgentTextByItemId = new Map<string, string>();
  private readonly lastReasoningTextByItemId = new Map<string, string>();
  private readonly seenToolCallIds = new Set<string>();
  private prevCumulativeUsage: CumulativeUsage | null;

  constructor(params: {
    sessionId?: string;
    thread: Thread;
    codexHome: string;
    snapshotConfig: UnifiedAgentSdkSessionConfigSnapshot;
    baseMetadata?: Record<string, unknown>;
    prevCumulativeUsage?: CumulativeUsage | null;
  }) {
    this.sessionId = params.sessionId;
    this.thread = params.thread;
    this.codexHome = params.codexHome;
    this.snapshotConfig = params.snapshotConfig;
    this.baseMetadata = params.baseMetadata;
    this.prevCumulativeUsage = params.prevCumulativeUsage ?? null;
  }

  async capabilities(): Promise<RuntimeCapabilities> {
    return {
      streamingOutput: true,
      structuredOutput: true,
      reasoningEvents: "best_effort",
      cancel: true,
      sessionResume: true,
      toolEvents: true,
      rawEvents: true,
    };
  }

  async status(): Promise<SessionStatus> {
    return { state: this.activeRunId ? "running" : "idle", activeRunId: this.activeRunId };
  }

  private withSessionId<T extends RuntimeEvent>(event: T): T {
    if (event.sessionId || !this.sessionId) return event;
    return { ...event, sessionId: this.sessionId };
  }

  async run(req: RunRequest<never>): Promise<RunHandle> {
    if (this.activeRunId) throw new SessionBusyError(this.activeRunId);
    const runId = randomUUID() as UUID;
    this.lastAgentTextByItemId.clear();
    this.lastReasoningTextByItemId.clear();
    this.seenToolCallIds.clear();

    const { input, images } = normalizeRunInput(req);
    const abortController = new AbortController();
    this.abortControllers.set(runId, abortController);
    const signal = req.config?.signal;
    let removeExternalAbortListener: (() => void) | undefined;
    if (signal) {
      const mirrorAbort = () => abortController.abort(signal.reason);
      signal.addEventListener("abort", mirrorAbort, { once: true });
      removeExternalAbortListener = () => signal.removeEventListener("abort", mirrorAbort);
      if (signal.aborted) {
        mirrorAbort();
        removeExternalAbortListener();
      }
    }
    const { schemaForProvider, unwrapStructuredOutput } = normalizeStructuredOutputSchema(req.config?.outputSchema);
    const turnOptions = { outputSchema: schemaForProvider, signal: abortController.signal };

    let resolveResult!: (value: Extract<RuntimeEvent, { type: "run.completed" }>) => void;
    let resultResolved = false;
    const result = new Promise<Extract<RuntimeEvent, { type: "run.completed" }>>((resolve) => {
      resolveResult = (value) => {
        resultResolved = true;
        resolve(value);
      };
    });
    const resolveResultWithSession = (value: Extract<RuntimeEvent, { type: "run.completed" }>) => {
      resolveResult(this.withSessionId(value));
    };

    this.activeRunId = runId;
    const events = new AsyncEventStream<RuntimeEvent>();
    void (async () => {
      try {
        for await (const ev of this.runEvents(
          runId,
          input,
          images,
          turnOptions,
          unwrapStructuredOutput,
          resolveResultWithSession,
          abortController,
        )) {
          const enriched = this.withSessionId(ev);
          events.push(enriched);
          if (enriched.type === "run.completed") {
            this.abortControllers.delete(runId);
            if (this.activeRunId === runId) this.activeRunId = undefined;
          }
        }
      } catch (error) {
        if (!resultResolved) {
          const cancelled = abortController.signal.aborted;
          const done: Extract<RuntimeEvent, { type: "run.completed" }> = {
            type: "run.completed",
            atMs: Date.now(),
            runId,
            status: cancelled ? "cancelled" : "error",
            raw: error,
          };
          if (!cancelled) {
            events.push(
              this.withSessionId({
                type: "error",
                atMs: Date.now(),
                runId,
                message: formatFailedMessage("Codex run failed", error),
                raw: error,
              }),
            );
          }
          const enrichedDone = this.withSessionId(done);
          events.push(enrichedDone);
          resolveResult(enrichedDone);
        }
      } finally {
        removeExternalAbortListener?.();
        this.abortControllers.delete(runId);
        if (this.activeRunId === runId) this.activeRunId = undefined;
        events.close();
      }
    })();

    return {
      runId,
      events,
      result,
      cancel: async () => abortController.abort(),
    };
  }

  private async *runEvents(
    runId: UUID,
    input: string,
    images: string[],
    turnOptions: { outputSchema?: unknown; signal?: AbortSignal },
    unwrapStructuredOutput: (value: unknown) => unknown,
    resolveResult: (value: Extract<RuntimeEvent, { type: "run.completed" }>) => void,
    abortController: AbortController,
  ): AsyncGenerator<RuntimeEvent> {
    const startedAt = Date.now();
    let finalText: string | undefined;
    let reasoningText: string | undefined;
    let completed = false;

    try {
      yield {
        type: "run.started",
        atMs: startedAt,
        provider: PROVIDER_CODEX_SDK,
        sessionId: this.sessionId,
        runId,
      };

      const codexInput = images.length
        ? [
            { type: "text" as const, text: input },
            ...images.map((path) => ({ type: "local_image" as const, path })),
          ]
        : input;

      const streamed = await this.thread.runStreamed(codexInput, turnOptions);
      for await (const ev of streamed.events) {
        if (ev.type === "thread.started") {
          this.sessionId = ev.thread_id;
        }

        yield* this.mapEvent(runId, ev, {
          setFinalText: (t) => {
            finalText = t;
          },
          setReasoningText: (t) => {
            reasoningText = t;
          },
        });

        if (ev.type === "turn.completed") {
          const contextLength =
            this.sessionId && this.codexHome
              ? await readCodexLastCallContextLengthFromSessionLog({
                  codexHome: this.codexHome,
                  threadId: this.sessionId,
                  startAtMs: startedAt,
                  endAtMs: Date.now(),
                })
              : undefined;

          const current: CumulativeUsage = {
            input_tokens: ev.usage.input_tokens,
            cached_input_tokens: typeof ev.usage.cached_input_tokens === "number" ? ev.usage.cached_input_tokens : 0,
            output_tokens: ev.usage.output_tokens,
          };

          const { delta, wasReset } = computeUsageDelta(current, this.prevCumulativeUsage);
          this.prevCumulativeUsage = current;

          const u = {
            input_tokens: delta.input_tokens,
            cache_read_tokens: delta.cached_input_tokens,
            cache_write_tokens: 0,
            output_tokens: delta.output_tokens,
            total_tokens: delta.input_tokens + delta.output_tokens,
            context_length: contextLength,
            duration_ms: Date.now() - startedAt,
            raw: {
              ...ev.usage,
              __cumulative: current,
              __wasReset: wasReset,
            },
          };
          const parsed = turnOptions.outputSchema && typeof finalText === "string" ? tryParseJson(finalText) : undefined;
          const structuredOutput = parsed === undefined ? undefined : unwrapStructuredOutput(parsed);
          const done: Extract<RuntimeEvent, { type: "run.completed" }> = {
            type: "run.completed",
            atMs: Date.now(),
            runId,
            status: "success",
            finalText,
            structuredOutput,
            usage: u,
            raw: { ...(ev as any), reasoningText },
          };
          completed = true;
          yield done;
          resolveResult(done);
          break;
        }

        if (ev.type === "turn.failed") {
          const done: Extract<RuntimeEvent, { type: "run.completed" }> = {
            type: "run.completed",
            atMs: Date.now(),
            runId,
            status: abortController.signal.aborted ? "cancelled" : "error",
            finalText,
            raw: ev,
          };
          completed = true;
          yield done;
          resolveResult(done);
          break;
        }

        if (ev.type === "error") {
          if (!abortController.signal.aborted) {
            yield { type: "error", atMs: Date.now(), runId, message: ev.message, raw: ev };
          }
          const done: Extract<RuntimeEvent, { type: "run.completed" }> = {
            type: "run.completed",
            atMs: Date.now(),
            runId,
            status: abortController.signal.aborted ? "cancelled" : "error",
            finalText,
            raw: ev,
          };
          completed = true;
          yield done;
          resolveResult(done);
          break;
        }
      }
      if (!completed) {
        const cancelled = abortController.signal.aborted;
        if (!cancelled) {
          yield { type: "error", atMs: Date.now(), runId, message: "Codex stream ended without completion." };
        }
        const parsed = turnOptions.outputSchema && typeof finalText === "string" ? tryParseJson(finalText) : undefined;
        const structuredOutput = parsed === undefined ? undefined : unwrapStructuredOutput(parsed);
        const done: Extract<RuntimeEvent, { type: "run.completed" }> = {
          type: "run.completed",
          atMs: Date.now(),
          runId,
          status: cancelled ? "cancelled" : "error",
          finalText,
          structuredOutput,
        };
        completed = true;
        yield done;
        resolveResult(done);
      }
    } catch (error) {
      const cancelled = abortController.signal.aborted;
      if (!cancelled) {
        yield { type: "error", atMs: Date.now(), runId, message: formatFailedMessage("Codex run failed", error), raw: error };
      }
      if (!completed) {
        const done: Extract<RuntimeEvent, { type: "run.completed" }> = {
          type: "run.completed",
          atMs: Date.now(),
          runId,
          status: cancelled ? "cancelled" : "error",
          finalText,
          raw: error,
        };
        yield done;
        resolveResult(done);
      }
    } finally {
      this.abortControllers.delete(runId);
      if (this.activeRunId === runId) this.activeRunId = undefined;
    }
  }

  private *mapEvent(
    runId: UUID,
    ev: ThreadEvent,
    handlers: { setFinalText: (text: string) => void; setReasoningText: (text: string) => void },
  ): Generator<RuntimeEvent> {
    const computeAgentDelta = (item: { id: string; text: string }): string | null => {
      const prev = this.lastAgentTextByItemId.get(item.id) ?? "";
      const next = item.text ?? "";
      this.lastAgentTextByItemId.set(item.id, next);

      if (next.length >= prev.length && next.startsWith(prev)) {
        const delta = next.slice(prev.length);
        return delta || null;
      }

      if (next && next !== prev) {
        return next;
      }

      return null;
    };

    const computeReasoningDelta = (item: { id: string; text: string }): string | null => {
      const prev = this.lastReasoningTextByItemId.get(item.id) ?? "";
      const next = item.text ?? "";
      this.lastReasoningTextByItemId.set(item.id, next);

      if (next.length >= prev.length && next.startsWith(prev)) {
        const delta = next.slice(prev.length);
        return delta || null;
      }

      if (next && next !== prev) return next;
      return null;
    };

    const toolCallNameAndInput = (item: any): { toolName: string; input: unknown } | null => {
      if (item.type === "command_execution") return { toolName: "Bash", input: { command: item.command } };
      if (item.type === "mcp_tool_call") return { toolName: `${item.server}.${item.tool}`, input: item.arguments };
      if (item.type === "web_search") return { toolName: "WebSearch", input: { query: item.query } };
      return null;
    };

    if (ev.type === "item.updated") {
      const item = ev.item;
      if (item.type === "agent_message") {
        const delta = computeAgentDelta(item);
        if (delta) yield { type: "assistant.delta", atMs: Date.now(), runId, textDelta: delta, raw: ev };
        return;
      }
      if (item.type === "reasoning") {
        const delta = computeReasoningDelta(item);
        if (delta) yield { type: "assistant.reasoning.delta", atMs: Date.now(), runId, textDelta: delta, raw: ev };
        return;
      }
    }

    if (ev.type === "item.started") {
      const item = ev.item;
      if (item.type === "agent_message") {
        const delta = computeAgentDelta(item);
        if (delta) yield { type: "assistant.delta", atMs: Date.now(), runId, textDelta: delta, raw: ev };
        return;
      }
      if (item.type === "reasoning") {
        const delta = computeReasoningDelta(item);
        if (delta) yield { type: "assistant.reasoning.delta", atMs: Date.now(), runId, textDelta: delta, raw: ev };
        return;
      }
      if (item.type === "command_execution") {
        this.seenToolCallIds.add(item.id);
        yield {
          type: "tool.call",
          atMs: Date.now(),
          runId,
          callId: item.id as UUID,
          toolName: "Bash",
          input: { command: item.command },
          raw: ev,
        };
        return;
      }
      if (item.type === "mcp_tool_call") {
        this.seenToolCallIds.add(item.id);
        yield {
          type: "tool.call",
          atMs: Date.now(),
          runId,
          callId: item.id as UUID,
          toolName: `${item.server}.${item.tool}`,
          input: item.arguments,
          raw: ev,
        };
        return;
      }
      if (item.type === "web_search") {
        this.seenToolCallIds.add(item.id);
        yield {
          type: "tool.call",
          atMs: Date.now(),
          runId,
          callId: item.id as UUID,
          toolName: "WebSearch",
          input: { query: item.query },
          raw: ev,
        };
        return;
      }
    }

    if (ev.type === "item.completed") {
      const item = ev.item;
      if (item.type === "agent_message") {
        this.lastAgentTextByItemId.delete(item.id);
        handlers.setFinalText(item.text);
        yield {
          type: "assistant.message",
          atMs: Date.now(),
          runId,
          message: { text: item.text },
          raw: ev,
        };
        return;
      }

      if (item.type === "file_change") {
        if (!this.seenToolCallIds.has(item.id)) {
          this.seenToolCallIds.add(item.id);
          yield {
            type: "tool.call",
            atMs: Date.now(),
            runId,
            callId: item.id as UUID,
            toolName: CODEX_WORKSPACE_PATCH_APPLIED_TOOL_NAME,
            input: { changes: item.changes },
            raw: ev,
          };
        }
        yield {
          type: "tool.result",
          atMs: Date.now(),
          runId,
          callId: item.id as UUID,
          output: { status: item.status, changes: item.changes },
          raw: ev,
        };
        if (item.status === "failed") {
          yield { type: "error", atMs: Date.now(), runId, message: "Codex file change patch failed.", raw: ev };
        }
        return;
      }

      if (item.type === "reasoning") {
        this.lastReasoningTextByItemId.delete(item.id);
        handlers.setReasoningText(item.text);
        yield {
          type: "assistant.reasoning.message",
          atMs: Date.now(),
          runId,
          message: { text: item.text },
          raw: ev,
        };
        return;
      }

      if (item.type === "command_execution") {
        const info = toolCallNameAndInput(item);
        if (info && !this.seenToolCallIds.has(item.id)) {
          this.seenToolCallIds.add(item.id);
          yield { type: "tool.call", atMs: Date.now(), runId, callId: item.id as UUID, toolName: info.toolName, input: info.input, raw: ev };
        }
        yield {
          type: "tool.result",
          atMs: Date.now(),
          runId,
          callId: item.id as UUID,
          output: {
            command: item.command,
            aggregatedOutput: item.aggregated_output,
            exitCode: item.exit_code,
            status: item.status,
          },
          raw: ev,
        };
        return;
      }

      if (item.type === "mcp_tool_call") {
        const info = toolCallNameAndInput(item);
        if (info && !this.seenToolCallIds.has(item.id)) {
          this.seenToolCallIds.add(item.id);
          yield { type: "tool.call", atMs: Date.now(), runId, callId: item.id as UUID, toolName: info.toolName, input: info.input, raw: ev };
        }
        yield {
          type: "tool.result",
          atMs: Date.now(),
          runId,
          callId: item.id as UUID,
          output: item.result ?? item.error ?? null,
          raw: ev,
        };
        return;
      }

      if (item.type === "web_search") {
        const info = toolCallNameAndInput(item);
        if (info && !this.seenToolCallIds.has(item.id)) {
          this.seenToolCallIds.add(item.id);
          yield { type: "tool.call", atMs: Date.now(), runId, callId: item.id as UUID, toolName: info.toolName, input: info.input, raw: ev };
        }
        yield {
          type: "tool.result",
          atMs: Date.now(),
          runId,
          callId: item.id as UUID,
          output: { query: item.query },
          raw: ev,
        };
        return;
      }
    }

    // Keep raw provider event available for advanced consumers.
    yield { type: "provider.event", atMs: Date.now(), runId, provider: PROVIDER_CODEX_SDK, payload: ev, raw: ev };
  }

  async cancel(runId?: UUID): Promise<void> {
    if (runId) {
      this.abortControllers.get(runId)?.abort();
      return;
    }
    for (const controller of this.abortControllers.values()) controller.abort();
  }

  async snapshot(): Promise<SessionHandle> {
    return {
      provider: PROVIDER_CODEX_SDK,
      sessionId: this.sessionId,
      metadata: mergeMetadata(
        mergeMetadata(this.baseMetadata, encodeUnifiedAgentSdkMetadata(this.snapshotConfig)),
        encodeCodexUsageMetadata(this.prevCumulativeUsage),
      ),
    };
  }

  async dispose(): Promise<void> {}
}

function formatFailedMessage(prefix: string, error: unknown): string {
  const detail = describeUnknownError(error);
  if (!detail) return `${prefix}.`;
  return `${prefix}: ${detail}`;
}

function describeUnknownError(error: unknown): string {
  if (error && typeof error === "object" && "message" in error && typeof (error as { message?: unknown }).message === "string") {
    return truncate(String((error as { message: string }).message));
  }
  if (error instanceof Error && typeof error.message === "string" && error.message) {
    return truncate(error.message);
  }
  try {
    return truncate(JSON.stringify(error));
  } catch {
    return truncate(String(error));
  }
}

function truncate(text: string, maxLen = 500): string {
  const t = text.trim();
  if (t.length <= maxLen) return t;
  return `${t.slice(0, maxLen)}…`;
}

function normalizeAccess(input: AccessConfig | undefined): Required<AccessConfig> {
  return {
    auto: input?.auto ?? "medium",
  };
}

function readUnifiedAgentSdkSessionConfig(handle: SessionHandle): UnifiedAgentSdkSessionConfigSnapshot | undefined {
  const metadata = handle.metadata;
  if (!metadata || typeof metadata !== "object") return undefined;
  const raw = (metadata as Record<string, unknown>)[UNIFIED_AGENT_SDK_SESSION_HANDLE_METADATA_KEY];
  if (!raw || typeof raw !== "object") return undefined;

  const parsed = raw as Partial<UnifiedAgentSdkSessionHandleMetadataV1>;
  if (parsed.version !== 1 || !parsed.sessionConfig || typeof parsed.sessionConfig !== "object") return undefined;

  const cfg = parsed.sessionConfig as Record<string, unknown>;
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

    out.access = {
      ...(auto === "low" || auto === "medium" || auto === "high" ? { auto } : {}),
    };
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

function readCodexUsageMetadata(handle: SessionHandle): CumulativeUsage | null {
  const metadata = handle.metadata;
  if (!metadata || typeof metadata !== "object") return null;
  const raw = (metadata as Record<string, unknown>)[UNIFIED_AGENT_SDK_CODEX_USAGE_METADATA_KEY];
  if (!raw || typeof raw !== "object") return null;

  const parsed = raw as Partial<CodexUsageMetadataV1>;
  if (parsed.version !== 1 || !parsed.cumulativeUsage || typeof parsed.cumulativeUsage !== "object") return null;

  const usage = parsed.cumulativeUsage as Partial<CumulativeUsage>;
  if (
    typeof usage.input_tokens !== "number" ||
    typeof usage.cached_input_tokens !== "number" ||
    typeof usage.output_tokens !== "number"
  ) {
    return null;
  }

  if (usage.input_tokens < 0 || usage.cached_input_tokens < 0 || usage.output_tokens < 0) return null;

  return {
    input_tokens: usage.input_tokens,
    cached_input_tokens: usage.cached_input_tokens,
    output_tokens: usage.output_tokens,
  };
}

function encodeUnifiedAgentSdkMetadata(sessionConfig: UnifiedAgentSdkSessionConfigSnapshot): Record<string, unknown> {
  const value: UnifiedAgentSdkSessionHandleMetadataV1 = { version: 1, sessionConfig };
  return { [UNIFIED_AGENT_SDK_SESSION_HANDLE_METADATA_KEY]: value };
}

function encodeCodexUsageMetadata(prevCumulativeUsage: CumulativeUsage | null): Record<string, unknown> {
  if (!prevCumulativeUsage) return {};
  const value: CodexUsageMetadataV1 = {
    version: 1,
    cumulativeUsage: prevCumulativeUsage,
  };
  return { [UNIFIED_AGENT_SDK_CODEX_USAGE_METADATA_KEY]: value };
}

function mergeMetadata(a: Record<string, unknown> | undefined, b: Record<string, unknown>): Record<string, unknown> {
  return { ...(a ?? {}), ...b };
}

function resolveCodexHome(client: CodexOptions | undefined): string {
  const fromClient = client?.env?.CODEX_HOME;
  if (typeof fromClient === "string" && fromClient.trim()) return fromClient.trim();

  const fromProcess = process.env.CODEX_HOME;
  if (typeof fromProcess === "string" && fromProcess.trim()) return fromProcess.trim();

  return join(os.homedir(), ".codex");
}

async function readCodexLastCallContextLengthFromSessionLog(params: {
  codexHome: string;
  threadId: string;
  startAtMs: number;
  endAtMs: number;
}): Promise<number | undefined> {
  const logPath = await findCodexRolloutLogPath(params.codexHome, params.threadId, params.endAtMs);
  if (!logPath) return undefined;

  // Token count events can land slightly before/after the unified run timestamps.
  const startMs = params.startAtMs - 1_000;
  const endMs = params.endAtMs + 2_000;

  let lastContextLength: number | undefined;

  try {
    const rl = createInterface({
      input: createReadStream(logPath, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      if (!line) continue;
      let entry: any;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }

      if (!entry || typeof entry !== "object") continue;
      if (entry.type !== "event_msg") continue;

      const payload = entry.payload;
      if (!payload || typeof payload !== "object") continue;
      if (payload.type !== "token_count") continue;

      const atMs = Date.parse(entry.timestamp);
      if (!Number.isFinite(atMs) || atMs < startMs || atMs > endMs) continue;

      const info = payload.info;
      if (!info || typeof info !== "object") continue;

      const last = info.last_token_usage;
      if (!last || typeof last !== "object") continue;

      const inputTokens = last.input_tokens;
      const outputTokens = last.output_tokens;
      if (typeof inputTokens !== "number" || typeof outputTokens !== "number") continue;

      lastContextLength = inputTokens + outputTokens;
    }
  } catch {
    return undefined;
  }

  return lastContextLength;
}

async function findCodexRolloutLogPath(codexHome: string, threadId: string, atMs: number): Promise<string | null> {
  const sessionsDir = join(codexHome, "sessions");

  const candidates = [new Date(atMs), new Date(atMs - 24 * 60 * 60 * 1000), new Date(atMs + 24 * 60 * 60 * 1000)];
  for (const d of candidates) {
    const yyyy = String(d.getFullYear());
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    const dayDir = join(sessionsDir, yyyy, mm, dd);

    let files: string[];
    try {
      files = await readdir(dayDir);
    } catch {
      continue;
    }

    const matches = files.filter((name) => name.includes(threadId) && name.endsWith(".jsonl"));
    if (!matches.length) continue;

    matches.sort();
    return join(dayDir, matches[matches.length - 1]);
  }

  return findCodexRolloutLogPathFallback(sessionsDir, threadId);
}

async function findCodexRolloutLogPathFallback(sessionsDir: string, threadId: string): Promise<string | null> {
  const stack = [sessionsDir];
  let scanned = 0;
  let best: { path: string; name: string } | null = null;

  while (stack.length && scanned < 5_000) {
    const dir = stack.pop();
    if (!dir) break;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      scanned += 1;
      if (scanned >= 5_000) break;
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(p);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(".jsonl") || !entry.name.includes(threadId)) continue;
      if (best === null || entry.name > best.name) best = { path: p, name: entry.name };
    }
  }

  return best?.path ?? null;
}

function mapUnifiedAccessToCodex(access: Required<AccessConfig>): Partial<ThreadOptions> {
  // Non-interactive by default; rely on sandbox boundaries instead of approval prompts.
  const approvalPolicy: ThreadOptions["approvalPolicy"] = "never";

  const sandboxMode: ThreadOptions["sandboxMode"] =
    access.auto === "low" ? "read-only" : access.auto === "medium" ? "workspace-write" : "danger-full-access";

  return {
    approvalPolicy,
    sandboxMode,
    // Unified `auto` always enables network + web search; `sandboxMode` is the primary restriction mechanism.
    networkAccessEnabled: true,
    webSearchEnabled: true,
  };
}

function mapReasoningEffortToCodex(effort: ReasoningEffort): NonNullable<ThreadOptions["modelReasoningEffort"]> {
  if (effort === "none") return "minimal";
  return effort;
}

function normalizeRunInput<TRunProvider>(req: RunRequest<TRunProvider>): { input: string; images: string[] } {
  if (isAsyncIterable(req.input)) {
    throw new Error("Codex adapter does not support streaming input (AsyncIterable<TurnInput>) yet.");
  }
  const turns = Array.isArray(req.input) ? req.input : [req.input];
  const images: string[] = [];
  let imageIndex = 0;

  const turnTexts: string[] = [];
  for (const turn of turns) {
    const blocks: string[] = [];
    for (const part of turn.parts) {
      if (part.type === "text") {
        blocks.push(part.text);
        continue;
      }
      if (part.type === "local_image") {
        images.push(part.path);
        imageIndex += 1;
        blocks.push(`[Image #${imageIndex}]`);
        continue;
      }
      throw new Error(`Unsupported content part for Codex adapter: ${(part as { type: string }).type}`);
    }
    turnTexts.push(blocks.join("\n\n"));
  }

  // Note: Codex CLI attaches images to the initial prompt (not truly interleaved).
  // To preserve user intent as much as possible, we inject stable placeholders into the prompt text
  // at the position where each image appeared in the unified input.
  return { input: turnTexts.join("\n\n"), images };
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return typeof (value as AsyncIterable<unknown> | null)?.[Symbol.asyncIterator] === "function";
}

function tryParseJson(text: string): unknown | undefined {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
