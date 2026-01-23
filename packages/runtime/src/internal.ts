import type {
  AccessConfig,
  ReasoningEffort,
  SessionConfig,
  SessionHandle,
  UnifiedAgentSdkSessionConfigSnapshot,
  UnifiedAgentSdkSessionHandleMetadataV1,
  WorkspaceConfig,
} from "@unified-agent-sdk/runtime-core";
import { UNIFIED_AGENT_SDK_SESSION_HANDLE_METADATA_KEY } from "@unified-agent-sdk/runtime-core";

export type SessionDefaults = {
  workspace?: WorkspaceConfig;
  access?: AccessConfig;
  model?: string;
  reasoningEffort?: ReasoningEffort;
};

export function mergeSessionConfigWithDefaults<TSessionProvider>(
  config: SessionConfig<TSessionProvider> | undefined,
  defaults: SessionDefaults,
): SessionConfig<TSessionProvider> {
  const base = (config ?? {}) as SessionConfig<TSessionProvider>;
  const mergedAccess = mergeAccess(sanitizeAccess(base.access), sanitizeAccess(defaults.access));

  return {
    ...base,
    ...(base.workspace ? {} : defaults.workspace ? { workspace: defaults.workspace } : {}),
    ...(base.model ? {} : defaults.model ? { model: defaults.model } : {}),
    ...(base.reasoningEffort ? {} : defaults.reasoningEffort ? { reasoningEffort: defaults.reasoningEffort } : {}),
    ...(mergedAccess ? { access: mergedAccess } : {}),
  };
}

export function mergeSessionHandleWithDefaults(handle: SessionHandle, defaults: SessionDefaults): SessionHandle {
  const existing = readUnifiedAgentSdkSessionConfigFromHandle(handle.metadata);
  const mergedAccess = mergeAccess(existing?.access, sanitizeAccess(defaults.access));

  const merged: UnifiedAgentSdkSessionConfigSnapshot = {
    ...(existing?.workspace ? { workspace: existing.workspace } : defaults.workspace ? { workspace: defaults.workspace } : {}),
    ...(mergedAccess ? { access: mergedAccess } : {}),
    ...(existing?.model ? { model: existing.model } : defaults.model ? { model: defaults.model } : {}),
    ...(existing?.reasoningEffort ? { reasoningEffort: existing.reasoningEffort } : defaults.reasoningEffort ? { reasoningEffort: defaults.reasoningEffort } : {}),
  };

  const metadata: UnifiedAgentSdkSessionHandleMetadataV1 = { version: 1, sessionConfig: merged };
  return {
    ...handle,
    metadata: {
      ...(handle.metadata ?? {}),
      [UNIFIED_AGENT_SDK_SESSION_HANDLE_METADATA_KEY]: metadata,
    },
  };
}

function readUnifiedAgentSdkSessionConfigFromHandle(
  metadata: Record<string, unknown> | undefined,
): UnifiedAgentSdkSessionConfigSnapshot | undefined {
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

  out.access = sanitizeAccess(cfg.access);

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

function mergeAccess(existing: AccessConfig | undefined, defaults: AccessConfig | undefined): AccessConfig | undefined {
  if (existing === undefined) return defaults ? { ...defaults } : undefined;
  if (defaults === undefined) return existing;
  return { ...defaults, ...existing };
}

function sanitizeAccess(access: unknown): AccessConfig | undefined {
  if (!access || typeof access !== "object" || Array.isArray(access)) return undefined;
  const auto = (access as { auto?: unknown }).auto;
  if (auto !== "low" && auto !== "medium" && auto !== "high") return undefined;
  return { auto };
}
