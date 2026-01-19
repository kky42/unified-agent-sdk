export type ProviderId = string & { readonly __providerIdBrand?: unique symbol };
export type UUID = string & { readonly __uuidBrand?: unique symbol };

export type JsonSchema = Record<string, unknown>;

export type SessionBusyErrorCode = "SESSION_BUSY";

export class SessionBusyError extends Error {
  public readonly code: SessionBusyErrorCode = "SESSION_BUSY";
  public readonly activeRunId: UUID;

  constructor(activeRunId: UUID) {
    super(`Session is busy (activeRunId=${activeRunId}).`);
    this.name = "SessionBusyError";
    this.activeRunId = activeRunId;
    Object.setPrototypeOf(this, SessionBusyError.prototype);
  }
}

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "local_image"; path: string };

export type TurnInput = {
  parts: ContentPart[];
};

export interface WorkspaceConfig {
  cwd: string;
  additionalDirs?: string[];
}

/**
 * Unified access controls.
 *
 * Notes:
 * - Providers differ in what can be enforced without an OS sandbox.
 * - This is intentionally small and maps to provider-native primitives (Codex sandbox modes, Claude permission modes).
 */
export type AccessLevel = "low" | "medium" | "high";

export type AccessConfig = {
  /**
   * High-level access preset.
   * - low: read-only
   * - medium: sandboxed writes/commands/tools
   * - high: unrestricted (no sandbox / bypass)
   */
  auto?: AccessLevel;
  /**
   * Allow outbound network access (provider-dependent).
   *
   * Notes:
   * - For Codex, this controls sandboxed command network access.
   * - For Claude, this controls network-capable tools (WebFetch) and network-ish Bash commands.
   */
  network?: boolean;
  /**
   * Allow the provider web search tool (provider-dependent).
   *
   * Notes:
   * - For Codex, this controls the `web_search` tool.
   * - For Claude, this controls the `WebSearch` tool.
   */
  webSearch?: boolean;
};

/**
 * Unified reasoning “effort” / thinking budget preset.
 *
 * Notes:
 * - Codex maps this to `ThreadOptions.modelReasoningEffort` (`minimal|low|medium|high|xhigh`).
 * - Claude maps this to a thinking token budget (`maxThinkingTokens`).
 */
export type ReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh";

export type ProviderConfig = Record<string, unknown>;

export interface SessionConfig<TProvider = ProviderConfig> {
  /**
   * Workspace / filesystem scope for the session (maps to provider-specific concepts like
   * Claude `cwd`+`additionalDirectories` and Codex `workingDirectory`+`additionalDirectories`).
   */
  workspace?: WorkspaceConfig;
  /**
   * Preferred model identifier for this session.
   *
   * Notes:
   * - This is optional and provider-dependent, but most providers support a string model name.
   * - When omitted, provider defaults and config files remain the source of truth.
   */
  model?: string;
  /**
   * Unified reasoning-effort preset.
   *
   * Semantics:
   * - Omitted: provider adapters default to `"medium"`.
   * - `"none"`: lowest effort (Codex `"minimal"`, Claude `maxThinkingTokens=0`).
   *
   * This is unified-owned; provider configs should not be the source of truth for this knob.
   */
  reasoningEffort?: ReasoningEffort;
  /**
   * Unified access controls applied by provider adapters.
   */
  access?: AccessConfig;
  /**
   * Provider-specific session configuration (opaque to runtime-core).
   * Each provider package exports strongly-typed shapes for this value.
   */
  provider?: TProvider;
}

export interface RunConfig<TRunProvider = ProviderConfig> {
  /**
   * JSON Schema describing expected structured output.
   * Support is provider-dependent (see `capabilities().structuredOutput`).
   */
  outputSchema?: JsonSchema;
  /** AbortSignal to cancel the run. */
  signal?: AbortSignal;
  /**
   * Provider-specific per-run configuration (opaque to runtime-core).
   * Each provider package may choose to support/ignore this.
   */
  provider?: TRunProvider;
}

export interface RunRequest<TRunProvider = ProviderConfig> {
  input: TurnInput | TurnInput[] | AsyncIterable<TurnInput>;
  config?: RunConfig<TRunProvider>;
}

export interface Usage {
  input_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  cost_usd?: number;
  duration_ms?: number;
  raw?: unknown;
}

export interface RuntimeCapabilities {
  streamingOutput: boolean;
  structuredOutput: boolean;
  /**
   * Reliability of `assistant.reasoning.*` events.
   *
   * Notes:
   * - Reasoning/thinking output is provider/model/setting-dependent.
   * - Consumers should treat reasoning events as optional unless `reliable`.
   */
  reasoningEvents?: "none" | "best_effort" | "reliable";
  cancel: boolean;
  sessionResume: boolean;
  toolEvents: boolean;
  rawEvents: boolean;
}

export type SessionState = "idle" | "running" | "error";

export interface SessionStatus {
  state: SessionState;
  activeRunId?: UUID;
  raw?: unknown;
}

export type RuntimeEvent =
  | {
      type: "run.started";
      atMs: number;
      provider: ProviderId;
      sessionId?: string;
      runId: UUID;
      raw?: unknown;
    }
  | {
      type: "assistant.delta";
      atMs: number;
      runId: UUID;
      textDelta: string;
      raw?: unknown;
    }
  | {
      type: "assistant.reasoning.delta";
      atMs: number;
      runId: UUID;
      textDelta: string;
      raw?: unknown;
    }
  | {
      type: "assistant.message";
      atMs: number;
      runId: UUID;
      message: {
        text: string;
        structuredOutput?: unknown;
      };
      raw?: unknown;
    }
  | {
      type: "assistant.reasoning.message";
      atMs: number;
      runId: UUID;
      message: {
        text: string;
      };
      raw?: unknown;
    }
  | {
      type: "provider.event";
      atMs: number;
      runId: UUID;
      provider: ProviderId;
      payload: unknown;
      raw?: unknown;
    }
  | {
      type: "tool.call";
      atMs: number;
      runId: UUID;
      callId: UUID;
      toolName: string;
      input: unknown;
      raw?: unknown;
    }
  | {
      type: "tool.result";
      atMs: number;
      runId: UUID;
      callId: UUID;
      output: unknown;
      raw?: unknown;
    }
  | {
      type: "run.completed";
      atMs: number;
      runId: UUID;
      status: "success" | "error" | "cancelled";
      finalText?: string;
      structuredOutput?: unknown;
      usage?: Usage;
      raw?: unknown;
    }
  | {
      type: "error";
      atMs: number;
      runId?: UUID;
      message: string;
      code?: string;
      raw?: unknown;
    };

export interface RunHandle {
  runId: UUID;
  events: AsyncIterable<RuntimeEvent>;
  result: Promise<Extract<RuntimeEvent, { type: "run.completed" }>>;
  cancel(): Promise<void>;
}

export interface SessionHandle {
  provider: ProviderId;
  sessionId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Reserved `SessionHandle.metadata` key used by this SDK to persist unified session config for lossless resume.
 *
 * Notes:
 * - Provider adapters may include this key in `snapshot()` results.
 * - `resumeSession()` implementations may read this key when present.
 */
export const UNIFIED_AGENT_SDK_SESSION_HANDLE_METADATA_KEY = "unifiedAgentSdk";

export type UnifiedAgentSdkSessionConfigSnapshot = {
  workspace?: WorkspaceConfig;
  access?: AccessConfig;
  model?: string;
  reasoningEffort?: ReasoningEffort;
};

export type UnifiedAgentSdkSessionHandleMetadataV1 = {
  version: 1;
  sessionConfig: UnifiedAgentSdkSessionConfigSnapshot;
};

export interface UnifiedSession<
  TSessionProvider = ProviderConfig,
  TRunProvider = ProviderConfig
> {
  provider: ProviderId;
  sessionId?: string;

  capabilities(): Promise<RuntimeCapabilities>;
  status(): Promise<SessionStatus>;

  run(req: RunRequest<TRunProvider>): Promise<RunHandle>;
  cancel(runId?: UUID): Promise<void>;

  snapshot(): Promise<SessionHandle>;
  dispose(): Promise<void>;
}

export interface UnifiedAgentRuntime<
  TSessionProvider = ProviderConfig,
  TRunProvider = ProviderConfig
> {
  provider: ProviderId;
  capabilities(): Promise<RuntimeCapabilities>;

  openSession(init: {
    config?: SessionConfig<TSessionProvider>;
  }): Promise<UnifiedSession<TSessionProvider, TRunProvider>>;

  resumeSession(handle: SessionHandle): Promise<UnifiedSession<TSessionProvider, TRunProvider>>;
  close(): Promise<void>;
}

export function asText(input: TurnInput): string {
  return input.parts
    .filter((p): p is Extract<ContentPart, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("\n\n");
}
