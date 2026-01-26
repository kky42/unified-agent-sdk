import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  query as claudeQuery,
  type Options as ClaudeOptions,
  type SDKAssistantMessage,
  type SDKMessage,
  type SDKPartialAssistantMessage,
  type SDKResultError,
  type SDKResultMessage,
  type SDKResultSuccess,
} from "@anthropic-ai/claude-agent-sdk";
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
import { asText, SessionBusyError, UNIFIED_AGENT_SDK_SESSION_HANDLE_METADATA_KEY } from "@unified-agent-sdk/runtime-core";
import { AsyncEventStream, normalizeStructuredOutputSchema } from "@unified-agent-sdk/runtime-core/internal";

export const PROVIDER_CLAUDE_AGENT_SDK = "@anthropic-ai/claude-agent-sdk" as ProviderId;

const DEFAULT_CLAUDE_SANDBOX_ALLOWED_DOMAINS = [
  // Claude Code sandbox networking is allow-list driven. Local HTTP APIs are critical for agents.
  "localhost",
  "127.0.0.1",
  "::1",
  "*.com",
  "*.net",
  "*.org",
  "*.io",
  "*.ai",
  "*.dev",
  "*.app",
  "*.co",
  "*.me",
  "*.gg",
  "*.edu",
  "*.gov",
  "*.us",
  "*.uk",
  "*.ca",
  "*.de",
  "*.fr",
  "*.jp",
  "*.cn",
  "*.in",
  "*.br",
  "*.au",
  "*.nz",
  "*.ch",
  "*.nl",
  "*.se",
  "*.no",
  "*.fi",
  "*.es",
  "*.it",
  "*.pl",
  "*.kr",
  "*.sg",
  "*.hk",
  "*.tw",
  "*.mx",
];

type UnifiedOwnedClaudeOptionKeys =
  | "cwd"
  | "additionalDirectories"
  | "resume"
  | "abortController"
  | "model"
  | "maxThinkingTokens";

export type ClaudeRuntimeConfig = {
  /**
   * Defaults applied to every `query()` call created by this runtime.
   * Unified-owned fields (workspace/resume/abort) are set by the adapter.
   */
  defaults?: Omit<ClaudeOptions, UnifiedOwnedClaudeOptionKeys>;
  /** Dependency injection for tests/advanced usage. */
  query?: typeof claudeQuery;
};

export type ClaudeSessionConfig = Omit<
  ClaudeOptions,
  UnifiedOwnedClaudeOptionKeys
>;

export class ClaudeRuntime
  implements UnifiedAgentRuntime<ClaudeSessionConfig, Partial<ClaudeSessionConfig>>
{
  public readonly provider = PROVIDER_CLAUDE_AGENT_SDK;
  private readonly defaults?: ClaudeRuntimeConfig["defaults"];
  private readonly queryFn: typeof claudeQuery;

  constructor(config: ClaudeRuntimeConfig = {}) {
    this.defaults = config.defaults;
    this.queryFn = config.query ?? claudeQuery;
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
    config?: SessionConfig<ClaudeSessionConfig>;
  }): Promise<UnifiedSession<ClaudeSessionConfig, Partial<ClaudeSessionConfig>>> {
    const sessionProvider: ClaudeSessionConfig = init.config?.provider ?? ({} as ClaudeSessionConfig);
    return new ClaudeSession({
      workspace: init.config?.workspace,
      access: init.config?.access,
      model: init.config?.model,
      reasoningEffort: init.config?.reasoningEffort,
      defaults: this.defaults,
      queryFn: this.queryFn,
      sessionProvider,
    });
  }

  async resumeSession(handle: SessionHandle): Promise<UnifiedSession<ClaudeSessionConfig, Partial<ClaudeSessionConfig>>> {
    if (!handle.sessionId) {
      throw new Error("Claude resumeSession requires sessionId (Claude session id).");
    }
    const restored = readUnifiedAgentSdkSessionConfig(handle);
    return new ClaudeSession({
      sessionId: handle.sessionId,
      workspace: restored?.workspace,
      access: restored?.access,
      model: restored?.model,
      reasoningEffort: restored?.reasoningEffort,
      defaults: this.defaults,
      queryFn: this.queryFn,
      baseMetadata: handle.metadata,
      sessionProvider: {} as ClaudeSessionConfig,
    });
  }

  async close(): Promise<void> {}
}

class ClaudeSession implements UnifiedSession<ClaudeSessionConfig, Partial<ClaudeSessionConfig>> {
  public readonly provider = PROVIDER_CLAUDE_AGENT_SDK;
  public sessionId?: string;

  private readonly workspace?: WorkspaceConfig;
  private readonly model?: string;
  private readonly reasoningEffort?: ReasoningEffort;
  private readonly defaults?: ClaudeRuntimeConfig["defaults"];
  private readonly queryFn: typeof claudeQuery;
  private readonly sessionProvider: ClaudeSessionConfig;
  private readonly access?: AccessConfig;
  private readonly baseMetadata?: Record<string, unknown>;
  private activeRunId: UUID | undefined;
  private readonly abortControllers = new Map<UUID, AbortController>();

  constructor(params: {
    sessionId?: string;
    workspace?: WorkspaceConfig;
    access?: AccessConfig;
    baseMetadata?: Record<string, unknown>;
    model?: string;
    reasoningEffort?: ReasoningEffort;
    defaults?: ClaudeRuntimeConfig["defaults"];
    queryFn: typeof claudeQuery;
    sessionProvider: ClaudeSessionConfig;
  }) {
    this.sessionId = params.sessionId;
    this.workspace = params.workspace;
    this.access = params.access;
    this.baseMetadata = params.baseMetadata;
    this.model = params.model;
    this.reasoningEffort = params.reasoningEffort;
    this.defaults = params.defaults;
    this.queryFn = params.queryFn;
    this.sessionProvider = params.sessionProvider;
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

  async run(req: RunRequest<Partial<ClaudeSessionConfig>>): Promise<RunHandle> {
    if (this.activeRunId) throw new SessionBusyError(this.activeRunId);
    const runId = randomUUID() as UUID;

    const abortController = new AbortController();
    this.abortControllers.set(runId, abortController);
    const signal = req.config?.signal;
    let removeExternalAbortListener: (() => void) | undefined;
    if (signal) {
      // Mirror external abort into the SDK abortController.
      const mirrorAbort = () => abortController.abort(signal.reason);
      signal.addEventListener("abort", mirrorAbort, { once: true });
      removeExternalAbortListener = () => signal.removeEventListener("abort", mirrorAbort);
      if (signal.aborted) {
        mirrorAbort();
        removeExternalAbortListener();
      }
    }

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
        for await (const ev of this.runEvents(runId, req, abortController, resolveResultWithSession)) {
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
                message: formatFailedMessage("Claude run failed", error),
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
    req: RunRequest<Partial<ClaudeSessionConfig>>,
    abortController: AbortController,
    resolveResult: (value: Extract<RuntimeEvent, { type: "run.completed" }>) => void,
  ): AsyncGenerator<RuntimeEvent> {
    const startedAt = Date.now();
    let completed = false;
    let finalText: string | undefined;
    let structuredOutput: unknown | undefined;
    const toolCallsSeen = new Set<string>();
    const toolResultsSeen = new Set<string>();

    const runProvider: Partial<ClaudeSessionConfig> = req.config?.provider ?? {};

    const access = normalizeAccess(this.access);

    const unifiedAccessOptions = mapUnifiedAccessToClaude(access, {
      cwd: this.workspace?.cwd,
      additionalDirs: this.workspace?.additionalDirs,
    });

    const { schemaForProvider, unwrapStructuredOutput } = normalizeStructuredOutputSchema(req.config?.outputSchema);

    // No special provider fields to strip in the new design.
    const { ...sessionProviderOptions } = this.sessionProvider ?? {};
    const { ...runProviderOptions } = runProvider ?? {};

    const options: ClaudeOptions = {
      ...(this.defaults ?? {}),
      ...sessionProviderOptions,
      ...runProviderOptions,
      ...unifiedAccessOptions,
      abortController,
      cwd: this.workspace?.cwd,
      additionalDirectories: this.workspace?.additionalDirs,
      // Always resume from the latest known Claude session id. Claude may rotate session ids (e.g. after subagents),
      // so using the initial sessionId can silently drop context.
      resume: this.sessionId,
    };

    // Claude sandbox write permissions are derived from `permissions.allow` rules for `Edit(...)` rather than `--add-dir`.
    // If we enable sandboxing (auto=medium), ensure that additional workspace roots are also writable in the sandbox.
    maybeInjectClaudeSandboxWriteRulesForAdditionalDirs(options, access, {
      cwd: this.workspace?.cwd,
      additionalDirs: this.workspace?.additionalDirs,
    });

    // Claude Code permission rules can pre-allow networky commands (e.g. `Bash(curl:*)`) in user settings.
    // To keep unified `auto=low` portable across providers (Codex read-only blocks curl), inject deny rules.
    maybeInjectClaudeDenyRulesForAutoLow(options, access);

    options.maxThinkingTokens = mapReasoningEffortToClaudeMaxThinkingTokens(this.reasoningEffort ?? "medium");
    if (this.model) options.model = this.model;
    if (options.settingSources === undefined) options.settingSources = ["user", "project"];
    if (schemaForProvider) {
      options.outputFormat = { type: "json_schema", schema: schemaForProvider };
    }

    try {
      yield {
        type: "run.started",
        atMs: startedAt,
        provider: PROVIDER_CLAUDE_AGENT_SDK,
        sessionId: this.sessionId,
        runId,
      };

      const prompt = normalizePrompt(req);
      const q = this.queryFn({ prompt, options });

      for await (const msg of q) {
        this.sessionId = (msg as { session_id?: string }).session_id ?? this.sessionId;

        const mapped = mapClaudeMessage(runId, msg, { toolCallsSeen, toolResultsSeen });
        for (const ev of mapped.events) yield ev;

        if (mapped.result) {
          finalText = mapped.result.finalText;
          structuredOutput = unwrapStructuredOutput(mapped.result.structuredOutput);
          const done: Extract<RuntimeEvent, { type: "run.completed" }> = {
            type: "run.completed",
            atMs: Date.now(),
            runId,
            status: mapped.result.status,
            finalText,
            structuredOutput,
            usage: mapped.result.usage,
            raw: msg,
          };
          completed = true;
          yield done;
          resolveResult(done);
          break;
        }

        if (mapped.events.length === 0) {
          yield {
            type: "provider.event",
            atMs: Date.now(),
            runId,
            provider: PROVIDER_CLAUDE_AGENT_SDK,
            payload: msg,
            raw: msg,
          };
        }
      }

      if (!completed && abortController.signal.aborted) {
        const done: Extract<RuntimeEvent, { type: "run.completed" }> = {
          type: "run.completed",
          atMs: Date.now(),
          runId,
          status: "cancelled",
          finalText,
        };
        completed = true;
        yield done;
        resolveResult(done);
      }

      if (!completed) {
        yield { type: "error", atMs: Date.now(), runId, message: "Claude stream ended without a result." };
        const done: Extract<RuntimeEvent, { type: "run.completed" }> = {
          type: "run.completed",
          atMs: Date.now(),
          runId,
          status: "error",
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
        // When Node spawn() fails due to a missing cwd, the error message often looks like:
        //   "Failed to spawn Claude Code process: spawn /path/to/node ENOENT"
        // which is misleading because the binary may exist.
        const workspaceHint =
          this.workspace?.cwd && typeof this.workspace.cwd === "string"
            ? ` (check workspace.cwd exists: ${this.workspace.cwd})`
            : "";
        yield {
          type: "error",
          atMs: Date.now(),
          runId,
          message: `${formatFailedMessage("Claude run failed", error)}${workspaceHint}`,
          raw: error,
        };
      }
      if (!completed) {
        const done: Extract<RuntimeEvent, { type: "run.completed" }> = {
          type: "run.completed",
          atMs: Date.now(),
          runId,
          status: cancelled ? "cancelled" : "error",
          finalText,
          structuredOutput,
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

  async cancel(runId?: UUID): Promise<void> {
    if (runId) {
      this.abortControllers.get(runId)?.abort();
      return;
    }
    for (const controller of this.abortControllers.values()) controller.abort();
  }

  async snapshot(): Promise<SessionHandle> {
    const snapshotConfig: UnifiedAgentSdkSessionConfigSnapshot = {
      workspace: this.workspace,
      access: normalizeAccess(this.access),
      model: this.model,
      reasoningEffort: this.reasoningEffort ?? "medium",
    };

    return {
      provider: PROVIDER_CLAUDE_AGENT_SDK,
      sessionId: this.sessionId,
      metadata: mergeMetadata(this.baseMetadata, encodeUnifiedAgentSdkMetadata(snapshotConfig)),
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

function encodeUnifiedAgentSdkMetadata(sessionConfig: UnifiedAgentSdkSessionConfigSnapshot): Record<string, unknown> {
  const value: UnifiedAgentSdkSessionHandleMetadataV1 = { version: 1, sessionConfig };
  return { [UNIFIED_AGENT_SDK_SESSION_HANDLE_METADATA_KEY]: value };
}

function mergeMetadata(a: Record<string, unknown> | undefined, b: Record<string, unknown>): Record<string, unknown> {
  return { ...(a ?? {}), ...b };
}

function mapReasoningEffortToClaudeMaxThinkingTokens(effort: ReasoningEffort): number {
  if (effort === "none") return 0;
  if (effort === "low") return 4_000;
  if (effort === "medium") return 8_000;
  if (effort === "high") return 12_000;
  return 16_000;
}

function mapUnifiedAccessToClaude(
  access: Required<AccessConfig>,
  workspace: { cwd?: string; additionalDirs?: string[] } | undefined,
): Partial<ClaudeOptions> {
  if (access.auto === "high") {
    return {
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      // Avoid conflicting with SDK-level prompt routing; bypass means no prompts.
      permissionPromptToolName: undefined,
      canUseTool: undefined,
      sandbox: { enabled: false },
    };
  }

  const isMedium = access.auto === "medium";
  const disallowedTools = ["AskUserQuestion"];
  if (!isMedium) disallowedTools.push("Write", "Edit", "NotebookEdit", "KillShell");

  return {
    permissionPromptToolName: undefined,
    permissionMode: "default",
    disallowedTools,
    sandbox: isMedium
      ? {
          enabled: true,
          autoAllowBashIfSandboxed: false,
          allowUnsandboxedCommands: false,
          network: {
            // Claude Code sandbox networking is allow-list driven. To make unified `auto=medium` practical,
            // allow localhost + a broad set of common public domains.
            allowedDomains: DEFAULT_CLAUDE_SANDBOX_ALLOWED_DOMAINS,
            allowLocalBinding: true,
          },
        }
      : { enabled: false },
    canUseTool: async (toolName, toolInput, meta) => {
      const deny = (message: string) => ({ behavior: "deny" as const, message, interrupt: false as const });
      if (disallowedTools.includes(toolName)) return deny(`Tool '${toolName}' is disabled by unified access.`);

      if (toolName === "Bash") {
        const command =
          toolInput && typeof toolInput === "object" && !Array.isArray(toolInput) && "command" in toolInput
            ? (toolInput as { command?: unknown }).command
            : undefined;
        if (typeof command !== "string" || !command.trim()) return deny("Bash command is missing.");

        // Prevent sandbox escape attempts in "medium".
        const dangerouslyDisableSandbox =
          toolInput && typeof toolInput === "object" && !Array.isArray(toolInput) && "dangerouslyDisableSandbox" in toolInput
            ? (toolInput as { dangerouslyDisableSandbox?: unknown }).dangerouslyDisableSandbox
            : undefined;
        if (isMedium && dangerouslyDisableSandbox === true) {
          return deny("Bash sandbox escape is disabled in auto=medium.");
        }

        if (!isMedium) {
          // auto=low: deny mutations; keep behavior portable across providers by denying networky commands.
          if (!isReadOnlyBashCommand(command, { allowNetwork: false })) {
            return deny("Bash command denied by unified access (auto=low).");
          }
        }
      }

      // Enforce "medium => restrict writes to workspace roots" (best-effort).
      // Reads can still happen outside the workspace.
      if (isMedium) {
        const blockedPath =
          meta && typeof meta === "object" && "blockedPath" in meta ? (meta as { blockedPath?: unknown }).blockedPath : undefined;
        const requestedPath =
          toolInput && typeof toolInput === "object" && !Array.isArray(toolInput) && "file_path" in toolInput
            ? (toolInput as { file_path?: unknown }).file_path
            : undefined;
        const path =
          typeof blockedPath === "string" && blockedPath ? blockedPath : typeof requestedPath === "string" && requestedPath ? requestedPath : undefined;

        const isWriteTarget = toolName === "Bash" ? isMutatingBashToolInput(toolInput) : isWriteLikeTool(toolName);
        if (path && isWriteTarget && !isPathWithinWorkspace(path, workspace)) {
          return deny(`Path '${path}' is outside the session workspace (auto=medium).`);
        }
      }

      const updatedInput =
        toolInput && typeof toolInput === "object" && !Array.isArray(toolInput) ? (toolInput as Record<string, unknown>) : {};
      return { behavior: "allow" as const, updatedInput };
    },
  };
}

function maybeInjectClaudeSandboxWriteRulesForAdditionalDirs(
  options: ClaudeOptions,
  access: Required<AccessConfig>,
  workspace: { cwd?: string; additionalDirs?: string[] } | undefined,
): void {
  if (access.auto !== "medium") return;
  if (!options.sandbox?.enabled) return;

  const extraArgs = options.extraArgs ?? {};
  if (typeof extraArgs.settings === "string" && extraArgs.settings.trim()) return;

  const additionalDirs = Array.isArray(workspace?.additionalDirs) ? workspace.additionalDirs : [];
  if (additionalDirs.length === 0) return;

  const baseDir = typeof workspace?.cwd === "string" && workspace.cwd ? workspace.cwd : undefined;
  const uniqueCanonicalDirs = new Set<string>();
  for (const dir of additionalDirs) {
    if (typeof dir !== "string" || !dir.trim()) continue;
    const canonical = canonicalizePathForWorkspaceCheck(dir, { baseDir });
    if (canonical && path.isAbsolute(canonical)) uniqueCanonicalDirs.add(canonical);
  }
  if (uniqueCanonicalDirs.size === 0) return;

  // Settings rules use `Edit(<path>)`. Prefix absolute paths with `//` (Claude Code treats `/...` as relative to the
  // settings file location).
  const allowRules = Array.from(uniqueCanonicalDirs).map((absDir) => `Edit(${toClaudeSettingsAbsolutePathGlob(absDir)})`);
  extraArgs.settings = JSON.stringify({ permissions: { allow: allowRules } });
  options.extraArgs = extraArgs;
}

const AUTO_LOW_CLAUDE_DENY_RULES: string[] = [
  "Bash(curl:*)",
  "Bash(wget:*)",
  "Bash(nc:*)",
  "Bash(ncat:*)",
  "Bash(ssh:*)",
  "Bash(scp:*)",
  "Bash(sftp:*)",
  "Bash(rsync:*)",
  "Bash(git clone:*)",
  "Bash(git fetch:*)",
  "Bash(git pull:*)",
];

function maybeInjectClaudeDenyRulesForAutoLow(options: ClaudeOptions, access: Required<AccessConfig>): void {
  if (access.auto !== "low") return;

  const extraArgs = options.extraArgs ?? {};

  const existingSettings =
    typeof extraArgs.settings === "string" && extraArgs.settings.trim() ? extraArgs.settings.trim() : undefined;

  let settings: Record<string, unknown> = {};
  if (existingSettings) {
    try {
      const parsed = JSON.parse(existingSettings) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) settings = parsed as Record<string, unknown>;
    } catch {
      // If an integrator provided non-JSON settings (e.g. a file path), don't override it.
      return;
    }
  }

  const permissionsRaw = settings.permissions;
  const permissions: Record<string, unknown> =
    permissionsRaw && typeof permissionsRaw === "object" && !Array.isArray(permissionsRaw)
      ? (permissionsRaw as Record<string, unknown>)
      : {};

  const denyRaw = permissions.deny;
  const deny = Array.isArray(denyRaw)
    ? denyRaw.filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    : [];
  const nextDeny = Array.from(new Set([...deny, ...AUTO_LOW_CLAUDE_DENY_RULES]));

  const nextSettings = {
    ...settings,
    permissions: {
      ...permissions,
      deny: nextDeny,
    },
  };

  extraArgs.settings = JSON.stringify(nextSettings);
  options.extraArgs = extraArgs;
}

function toClaudeSettingsAbsolutePathGlob(absPath: string): string {
  const trimmed = absPath.trim();
  const normalized = trimmed.replace(/[\\/]+$/, "");
  if (!normalized) return normalized;

  // On POSIX, Claude Code treats `/...` as relative-to-settings-file, so use `//...` to express an absolute path.
  if (normalized.startsWith("/")) return `//${normalized.slice(1)}/**`;

  // On Windows, absolute paths don't start with `/`; pass them through as-is.
  // Use a best-effort separator for the trailing glob.
  const sep = normalized.includes("\\") ? "\\" : "/";
  return `${normalized}${sep}**`;
}

function isWriteLikeTool(toolName: string): boolean {
  return toolName === "Write" || toolName === "Edit" || toolName === "NotebookEdit";
}

function isPathWithinWorkspace(path: string, workspace: { cwd?: string; additionalDirs?: string[] } | undefined): boolean {
  if (!workspace) return true;
  const roots: string[] = [];
  if (typeof workspace.cwd === "string" && workspace.cwd) roots.push(workspace.cwd);
  if (Array.isArray(workspace.additionalDirs)) {
    for (const d of workspace.additionalDirs) if (typeof d === "string" && d) roots.push(d);
  }
  if (roots.length === 0) return true;

  const canonicalTarget = canonicalizePathForWorkspaceCheck(path, { baseDir: workspace.cwd });
  if (!canonicalTarget) return false;

  // Best-effort normalization (including resolving `..` segments and symlinks when possible).
  // Claude Code itself performs the authoritative path resolution/sandboxing.
  return roots.some((root) => {
    const canonicalRoot = canonicalizePathForWorkspaceCheck(root, { baseDir: workspace.cwd });
    if (!canonicalRoot) return false;
    return isPathWithinRoot(canonicalTarget, canonicalRoot);
  });
}

function canonicalizePathForWorkspaceCheck(inputPath: string, opts: { baseDir?: string | undefined }): string | undefined {
  const p = inputPath.trim();
  if (!p) return undefined;
  const baseDir = typeof opts.baseDir === "string" && opts.baseDir ? opts.baseDir : undefined;
  const absPath = path.isAbsolute(p) ? path.resolve(p) : baseDir ? path.resolve(baseDir, p) : undefined;
  if (!absPath) return undefined;
  return bestEffortRealpath(absPath);
}

function bestEffortRealpath(absPath: string): string {
  let candidate = absPath;
  const suffix: string[] = [];
  // Resolve symlinks when the path (or an ancestor) exists, while still supporting writes to new files.
  for (;;) {
    try {
      const real = fs.realpathSync(candidate);
      return suffix.length ? path.join(real, ...suffix.reverse()) : real;
    } catch (err) {
      const code = getFsErrorCode(err);
      if (code !== "ENOENT" && code !== "ENOTDIR") return absPath;
      const parent = path.dirname(candidate);
      if (parent === candidate) return absPath;
      suffix.push(path.basename(candidate));
      candidate = parent;
    }
  }
}

function isPathWithinRoot(candidatePath: string, rootPath: string): boolean {
  const candidate = normalizePathForComparison(candidatePath);
  const root = normalizePathForComparison(rootPath);

  const rel = path.relative(root, candidate);
  if (rel === "") return true;
  if (rel === "..") return false;
  if (rel.startsWith(`..${path.sep}`)) return false;
  if (path.isAbsolute(rel)) return false;
  return true;
}

function normalizePathForComparison(p: string): string {
  // Windows paths are typically case-insensitive.
  return process.platform === "win32" ? p.toLowerCase() : p;
}

function getFsErrorCode(err: unknown): string | undefined {
  return err && typeof err === "object" && "code" in err && typeof (err as { code?: unknown }).code === "string"
    ? (err as { code: string }).code
    : undefined;
}

function isMutatingBashToolInput(toolInput: unknown): boolean {
  const command =
    toolInput && typeof toolInput === "object" && !Array.isArray(toolInput) && "command" in toolInput
      ? (toolInput as { command?: unknown }).command
      : undefined;
  if (typeof command !== "string" || !command.trim()) return false;
  // This intentionally matches the "definitely mutating" patterns from `isReadOnlyBashCommand`.
  if (/[><]|\\btee\\b/.test(command)) return true;
  if (/\\b(rm|mv|cp|mkdir|rmdir|touch|chmod|chown|chgrp|ln|dd|truncate|kill|pkill|xargs)\\b/.test(command)) return true;
  if (/\\b(sed\\s+-i|perl\\s+-i|python\\s+-c|node\\s+-e)\\b/.test(command)) return true;
  if (/\\b(git\\s+(commit|push|checkout|switch|reset|clean|rebase|merge|apply|cherry-pick|tag|stash))\\b/.test(command)) return true;
  return false;
}

function isReadOnlyBashCommand(command: string, opts: { allowNetwork: boolean }): boolean {
  const c = command.trim();
  if (!c) return false;

  // Deny obvious shell operators that frequently indicate mutation or complex execution.
  // This is intentionally conservative.
  if (/[><]|\\btee\\b/.test(c)) return false;

  // Deny common mutating commands.
  if (/\b(rm|mv|cp|mkdir|rmdir|touch|chmod|chown|chgrp|ln|dd|truncate|kill|pkill|xargs)\b/.test(c)) return false;
  if (/\b(sed\s+-i|perl\s+-i|python\s+-c|node\s+-e)\b/.test(c)) return false;
  if (/\b(git\s+(commit|push|checkout|switch|reset|clean|rebase|merge|apply|cherry-pick|tag|stash))\b/.test(c)) return false;

  // Network-sensitive commands.
  if (!opts.allowNetwork) {
    if (/\b(curl|wget|nc|ncat|ssh|scp|sftp|rsync)\b/.test(c)) return false;
    if (/\b(git\s+(clone|fetch|pull))\b/.test(c)) return false;
  }

  // If network is allowed, permit a narrow set of "fetch to stdout" commands.
  // This intentionally blocks common file-output flags.
  if (opts.allowNetwork) {
    if (/^\s*curl\b/.test(c)) {
      if (/\s(-o|--output|-O|--remote-name)\b/.test(c)) return false;
      return true;
    }
    if (/^\s*wget\b/.test(c)) {
      // `wget` writes to disk by default; only allow explicit stdout mode.
      const stdoutMode = /\s(-q)?-O-\b/.test(c) || /\s--output-document=-\b/.test(c);
      if (!stdoutMode) return false;
      if (/\s(--output-document|-O)\b(?!-)/.test(c)) return false;
      if (/\s(-o|--output-file|-P|--directory-prefix)\b/.test(c)) return false;
      return true;
    }
  }

  // Allow a small set of read-only commands (including common search).
  // Note: `git` is allowed only for read-only verbs here.
  if (/^\s*(ls|pwd|whoami|id|uname)\b/.test(c)) return true;
  if (/^\s*(cat|head|tail|wc|stat)\b/.test(c)) return true;
  if (/^\s*(rg|grep)\b/.test(c)) return true;
  if (/^\s*find\b/.test(c)) {
    // `find` can mutate (e.g. `-delete`) or execute arbitrary programs (e.g. `-exec`),
    // which would violate the "auto=low" read-only contract.
    if (/\s-(?:delete|exec(?:dir)?|ok(?:dir)?|fprint0?|fprintf|fls)\b/.test(c)) return false;
    return true;
  }
  if (/^\s*git\s+(status|diff|log|show)\b/.test(c)) return true;

  return false;
}

function normalizePrompt<TRunProvider>(req: RunRequest<TRunProvider>): string {
  if (isAsyncIterable(req.input)) {
    throw new Error("Claude adapter streaming input (AsyncIterable<TurnInput>) is not implemented yet.");
  }
  const turns = Array.isArray(req.input) ? req.input : [req.input];
  for (const turn of turns) {
    for (const part of turn.parts) {
      if (part.type !== "text") throw new Error(`Unsupported content part for Claude adapter: ${part.type}`);
    }
  }
  return turns.map(asText).join("\n\n");
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return typeof (value as AsyncIterable<unknown> | null)?.[Symbol.asyncIterator] === "function";
}

function mapClaudeMessage(
  runId: UUID,
  msg: SDKMessage,
  state?: { toolCallsSeen: Set<string>; toolResultsSeen: Set<string> },
): {
  events: RuntimeEvent[];
  result?: {
    status: "success" | "error";
    finalText?: string;
    structuredOutput?: unknown;
    usage?: { input_tokens?: number; cache_read_tokens?: number; cache_write_tokens?: number; output_tokens?: number; total_tokens?: number; cost_usd?: number; duration_ms?: number; raw?: unknown };
  };
} {
  if (msg.type === "tool_progress") {
    // `tool_progress` is a provider-specific status update; do not treat it as a tool call.
    // Let it pass through as a provider.event so we don't suppress the real tool_use inputs.
    return { events: [] };
  }

  if (msg.type === "stream_event") {
    const delta = extractTextDelta(msg as SDKPartialAssistantMessage);
    if (delta) {
      return { events: [{ type: "assistant.delta", atMs: Date.now(), runId, textDelta: delta, raw: msg }] };
    }
    const thinkingDelta = extractThinkingDelta(msg as SDKPartialAssistantMessage);
    if (thinkingDelta) {
      return { events: [{ type: "assistant.reasoning.delta", atMs: Date.now(), runId, textDelta: thinkingDelta, raw: msg }] };
    }
    return { events: [] };
  }

  if (msg.type === "assistant") {
    const { text, reasoning, toolUses } = extractAssistantContent(msg as SDKAssistantMessage);
    const events: RuntimeEvent[] = [];

    if (state) {
      for (const toolUse of toolUses) {
        if (!toolUse.id || !toolUse.name) continue;
        if (state.toolCallsSeen.has(toolUse.id)) continue;
        state.toolCallsSeen.add(toolUse.id);
        events.push({
          type: "tool.call",
          atMs: Date.now(),
          runId,
          callId: toolUse.id as UUID,
          toolName: toolUse.name,
          input: toolUse.input ?? null,
          raw: msg,
        });
      }
    }

    if (text) {
      events.push({
        type: "assistant.message",
        atMs: Date.now(),
        runId,
        message: { text },
        raw: msg,
      });
    }

    if (reasoning) {
      events.push({
        type: "assistant.reasoning.message",
        atMs: Date.now(),
        runId,
        message: { text: reasoning },
        raw: msg,
      });
    }

    return { events };
  }

  if (msg.type === "user") {
    const events: RuntimeEvent[] = [];
    if (state) {
      for (const r of extractToolResultsFromUserMessage(msg as any)) {
        if (!r.toolUseId) continue;
        if (state.toolResultsSeen.has(r.toolUseId)) continue;
        state.toolResultsSeen.add(r.toolUseId);
        events.push({
          type: "tool.result",
          atMs: Date.now(),
          runId,
          callId: r.toolUseId as UUID,
          output: r.output,
          raw: msg,
        });
      }
    }
    return { events };
  }

  if (msg.type === "result") {
    const r = msg as SDKResultMessage;
    if (r.subtype === "success") {
      const success = r as SDKResultSuccess;
      const tokenUsage = extractClaudeTokenUsage(success.usage);
      return {
        events: [],
        result: {
          status: "success",
          finalText: success.result,
          structuredOutput: success.structured_output,
          usage: {
            ...tokenUsage,
            cost_usd: success.total_cost_usd,
            duration_ms: success.duration_ms,
            raw: success.usage,
          },
        },
      };
    }

    const error = r as SDKResultError;
    const tokenUsage = extractClaudeTokenUsage(error.usage);
    return {
      events: [],
      result: {
        status: "error",
        finalText: error.errors?.join("\n") ?? undefined,
        usage: { ...tokenUsage, cost_usd: error.total_cost_usd, duration_ms: error.duration_ms, raw: error.usage },
      },
    };
  }

  return { events: [] };
}

function extractTextDelta(msg: SDKPartialAssistantMessage): string | null {
  const ev = msg.event as unknown as { type?: string; delta?: { type?: string; text?: string } };
  if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta" && typeof ev.delta.text === "string") {
    return ev.delta.text;
  }
  return null;
}

function extractThinkingDelta(msg: SDKPartialAssistantMessage): string | null {
  const ev = msg.event as unknown as { type?: string; delta?: { type?: string; thinking?: string } };
  if (ev?.type === "content_block_delta" && ev.delta?.type === "thinking_delta" && typeof ev.delta.thinking === "string") {
    return ev.delta.thinking;
  }
  return null;
}

function extractAssistantText(msg: SDKAssistantMessage): string | null {
  const m = msg.message as unknown as { content?: unknown };
  const content = m?.content;
  if (!Array.isArray(content)) return null;
  const texts = content
    .map((b) => (b && typeof b === "object" ? (b as { type?: string; text?: string }).type === "text" ? (b as { text?: string }).text : undefined : undefined))
    .filter((t): t is string => typeof t === "string");
  return texts.length ? texts.join("") : null;
}

function extractAssistantContent(
  msg: SDKAssistantMessage,
): { text: string | null; reasoning: string | null; toolUses: Array<{ id?: string; name?: string; input?: unknown }> } {
  const m = msg.message as unknown as { content?: unknown };
  const content = m?.content;
  if (!Array.isArray(content)) return { text: extractAssistantText(msg), reasoning: null, toolUses: [] };

  const texts: string[] = [];
  const reasonings: string[] = [];
  const toolUses: Array<{ id?: string; name?: string; input?: unknown }> = [];

  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as any;
    if (b.type === "text" && typeof b.text === "string") texts.push(b.text);
    if (b.type === "tool_use") toolUses.push({ id: typeof b.id === "string" ? b.id : undefined, name: b.name, input: b.input });
    if (b.type === "thinking" && typeof b.thinking === "string") reasonings.push(b.thinking);
  }

  return { text: texts.length ? texts.join("") : null, reasoning: reasonings.length ? reasonings.join("") : null, toolUses };
}

function extractToolResultsFromUserMessage(msg: any): Array<{ toolUseId?: string; output: unknown }> {
  const m = msg?.message;
  const content = m?.content;
  if (!Array.isArray(content)) return [];

  const results: Array<{ toolUseId?: string; output: unknown }> = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as any;
    if (b.type !== "tool_result") continue;

    const toolUseId = typeof b.tool_use_id === "string" ? b.tool_use_id : typeof b.toolUseId === "string" ? b.toolUseId : undefined;
    results.push({ toolUseId, output: b });
  }
  return results;
}

function extractClaudeTokenUsage(usage: unknown): {
  input_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
} {
  const u = usage as any;
  const inputTokens = typeof u?.input_tokens === "number" ? u.input_tokens : typeof u?.inputTokens === "number" ? u.inputTokens : undefined;
  const outputTokens = typeof u?.output_tokens === "number" ? u.output_tokens : typeof u?.outputTokens === "number" ? u.outputTokens : undefined;
  const cacheReadTokens =
    typeof u?.cache_read_input_tokens === "number"
      ? u.cache_read_input_tokens
      : typeof u?.cacheReadInputTokens === "number"
        ? u.cacheReadInputTokens
        : undefined;
  const cacheWriteTokens =
    typeof u?.cache_creation_input_tokens === "number"
      ? u.cache_creation_input_tokens
      : typeof u?.cacheCreationInputTokens === "number"
        ? u.cacheCreationInputTokens
        : undefined;

  const totalTokens =
    [inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens].every((x) => typeof x === "number")
      ? (inputTokens as number) + (cacheReadTokens as number) + (cacheWriteTokens as number) + (outputTokens as number)
      : undefined;

  return {
    input_tokens: inputTokens,
    cache_read_tokens: cacheReadTokens,
    cache_write_tokens: cacheWriteTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
  };
}
