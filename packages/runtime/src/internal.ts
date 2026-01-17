import type { AccessConfig, ReasoningEffort, SessionConfig, WorkspaceConfig } from "@unified-agent-sdk/runtime-core";

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
  const mergedAccess =
    base.access === undefined
      ? defaults.access
        ? { ...defaults.access }
        : undefined
      : defaults.access
        ? { ...defaults.access, ...base.access }
        : base.access;

  return {
    ...base,
    ...(base.workspace ? {} : defaults.workspace ? { workspace: defaults.workspace } : {}),
    ...(base.model ? {} : defaults.model ? { model: defaults.model } : {}),
    ...(base.reasoningEffort ? {} : defaults.reasoningEffort ? { reasoningEffort: defaults.reasoningEffort } : {}),
    ...(mergedAccess ? { access: mergedAccess } : {}),
  };
}
