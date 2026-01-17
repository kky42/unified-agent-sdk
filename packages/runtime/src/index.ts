export * from "@unified-agent-sdk/runtime-core";

export {
  ClaudeRuntime,
  PROVIDER_CLAUDE_AGENT_SDK,
  type ClaudeRuntimeConfig,
  type ClaudeSessionConfig,
} from "@unified-agent-sdk/provider-claude";

export {
  CodexRuntime,
  PROVIDER_CODEX_SDK,
  type CodexRuntimeConfig,
  type CodexSessionConfig,
} from "@unified-agent-sdk/provider-codex";

import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { ClaudeRuntime, type ClaudeRuntimeConfig, type ClaudeSessionConfig } from "@unified-agent-sdk/provider-claude";
import { CodexRuntime, type CodexRuntimeConfig, type CodexSessionConfig } from "@unified-agent-sdk/provider-codex";
import type { AccessConfig, ReasoningEffort, SessionHandle, UnifiedAgentRuntime, WorkspaceConfig } from "@unified-agent-sdk/runtime-core";
import type { ThreadOptions } from "@openai/codex-sdk";

import { mergeSessionConfigWithDefaults } from "./internal.js";

export type EnvVars = Record<string, string | undefined>;

export type DefaultOpts = {
  /** Default workspace applied to `openSession()` when omitted. */
  workspace?: WorkspaceConfig;
  /** Default unified access applied to `openSession()` when omitted. */
  access?: AccessConfig;
  /** Default model applied to `openSession()` when omitted. */
  model?: string;
  /** Default reasoning effort applied to `openSession()` when omitted. */
  reasoningEffort?: ReasoningEffort;
};

export type CreateCodexRuntimeInit = {
  provider: "@openai/codex-sdk";
  /**
   * Codex config directory.
   * - `null` / omitted: inherit default location (`~/.codex`) or existing `CODEX_HOME`.
   * - string: sets `CODEX_HOME` for the Codex CLI process.
   */
  home?: string | null;
  /** Extra env vars merged into the provider process environment. */
  env?: EnvVars;
  /** Portable defaults applied to sessions when omitted. */
  defaultOpts?: DefaultOpts;
};

export type CreateClaudeRuntimeInit = {
  provider: "@anthropic-ai/claude-agent-sdk";
  /**
   * Claude Code config directory.
   * - `null` / omitted: inherit default location (`~/.claude`) or existing `CLAUDE_CONFIG_DIR`.
   * - string: sets `CLAUDE_CONFIG_DIR` for the Claude Code process.
   */
  home?: string | null;
  /** Extra env vars merged into the provider process environment. */
  env?: EnvVars;
  /**
   * Provider-specific process spawning overrides for Claude Code.
   *
   * Notes:
   * - The upstream SDK defaults to spawning `node` from PATH.
   * - If your PATH is minimal (common in some terminal/GUI setups), set `executable`
   *   to an absolute Node path (e.g. from nvm) to avoid `spawn node ENOENT`.
   * - You can also point `pathToClaudeCodeExecutable` at a `claude` binary.
   */
  claude?: {
    /**
     * Executable used to run Claude Code when `pathToClaudeCodeExecutable` points to a JS entrypoint.
     * The upstream SDK types this as a small enum, but in practice any string accepted by `child_process.spawn()`
     * (including an absolute path) can be useful, so this is typed as `string` here.
     */
    executable?: string;
    executableArgs?: string[];
    pathToClaudeCodeExecutable?: string;
  };
  /** Portable defaults applied to sessions when omitted. */
  defaultOpts?: DefaultOpts;
};

export type CreateRuntimeInit = CreateCodexRuntimeInit | CreateClaudeRuntimeInit;

export function createRuntime(init: CreateCodexRuntimeInit): UnifiedAgentRuntime<CodexSessionConfig, never>;
export function createRuntime(
  init: CreateClaudeRuntimeInit,
): UnifiedAgentRuntime<ClaudeSessionConfig, Partial<ClaudeSessionConfig>>;
export function createRuntime(init: CreateRuntimeInit): unknown {
  if (init.provider === "@openai/codex-sdk") return createCodexRuntime(init);
  if (init.provider === "@anthropic-ai/claude-agent-sdk") return createClaudeRuntime(init);
  throw new Error(`Unsupported provider: ${String((init as { provider: unknown }).provider)}`);
}

function createCodexRuntime(init: CreateCodexRuntimeInit): UnifiedAgentRuntime<CodexSessionConfig, never> {
  const home = init.home;
  const env = mergeIntoStringEnv(init.env);
  ensureNodeInPath(env);
  if (typeof home === "string") env.CODEX_HOME = home;
  const defaultOpts = init.defaultOpts;

  const defaults: ThreadOptions = {
    // Codex CLI enforces "must be a git repo" by default; default to allowing non-git workspaces.
    skipGitRepoCheck: true,
  };

  const runtime = new CodexRuntime({
    client: { env },
    defaults,
  } satisfies CodexRuntimeConfig);

  return withSessionDefaults(runtime, {
    prepare: typeof home === "string" ? async () => void (await mkdir(home, { recursive: true })) : undefined,
    workspace: defaultOpts?.workspace,
    access: defaultOpts?.access,
    model: defaultOpts?.model,
    reasoningEffort: defaultOpts?.reasoningEffort,
  });
}

function createClaudeRuntime(
  init: CreateClaudeRuntimeInit,
): UnifiedAgentRuntime<ClaudeSessionConfig, Partial<ClaudeSessionConfig>> {
  const home = init.home;
  const env = mergeIntoOptionalEnv(init.env);
  // Improve robustness in non-interactive environments (see docs/claude.md).
  if (
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC === undefined &&
    !(init.env && Object.prototype.hasOwnProperty.call(init.env, "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"))
  ) {
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  }
  ensureNodeInPath(env);
  if (typeof home === "string") env.CLAUDE_CONFIG_DIR = home;
  const defaultOpts = init.defaultOpts;

  const runtime = new ClaudeRuntime({
    defaults: {
      // Defaults tuned for "just work" behavior in orchestrators.
      includePartialMessages: true,
      // Needed for consistent non-interactive streaming behavior.
      extraArgs: { print: null },
      // The upstream SDK defaults this to "node" (PATH lookup). Use an absolute path by default for robustness.
      executable: (init.claude?.executable as any) ?? process.execPath,
      ...(init.claude?.executableArgs ? { executableArgs: init.claude.executableArgs } : {}),
      ...(init.claude?.pathToClaudeCodeExecutable
        ? { pathToClaudeCodeExecutable: init.claude.pathToClaudeCodeExecutable }
        : {}),
      env,
    },
  } satisfies ClaudeRuntimeConfig);

  return withSessionDefaults(runtime, {
    prepare: typeof home === "string" ? async () => void (await mkdir(home, { recursive: true })) : undefined,
    workspace: defaultOpts?.workspace,
    access: defaultOpts?.access,
    model: defaultOpts?.model,
    reasoningEffort: defaultOpts?.reasoningEffort,
    resumeSession: async (handle) => {
      if (!handle.nativeSessionId) throw new Error("Claude resumeSession requires nativeSessionId (Claude session id).");
      return runtime.openSession({
        sessionId: handle.sessionId,
        config: {
          ...(defaultOpts?.workspace ? { workspace: defaultOpts.workspace } : {}),
          ...(defaultOpts?.access ? { access: defaultOpts.access } : {}),
          ...(defaultOpts?.model ? { model: defaultOpts.model } : {}),
          ...(defaultOpts?.reasoningEffort ? { reasoningEffort: defaultOpts.reasoningEffort } : {}),
          provider: { resumeSessionId: handle.nativeSessionId } as ClaudeSessionConfig,
        },
      });
    },
  });
}

function withSessionDefaults<TSessionProvider, TRunProvider>(
  runtime: UnifiedAgentRuntime<TSessionProvider, TRunProvider>,
  defaults: {
    prepare?: () => Promise<void>;
    workspace?: WorkspaceConfig;
    access?: AccessConfig;
    model?: string;
    reasoningEffort?: ReasoningEffort;
    resumeSession?: (handle: SessionHandle) => ReturnType<UnifiedAgentRuntime<TSessionProvider, TRunProvider>["resumeSession"]>;
  },
): UnifiedAgentRuntime<TSessionProvider, TRunProvider> {
  let prepared: Promise<void> | null = null;
  const prepareOnce = async () => {
    if (!defaults.prepare) return;
    prepared ??= defaults.prepare();
    await prepared;
  };

  return {
    provider: runtime.provider,
    capabilities: () => runtime.capabilities(),
    openSession: async (init) => {
      await prepareOnce();
      const merged = mergeSessionConfigWithDefaults(init.config, defaults) as typeof init.config;
      return runtime.openSession({ sessionId: init.sessionId, config: merged });
    },
    resumeSession: async (handle) => {
      await prepareOnce();
      if (defaults.resumeSession) return defaults.resumeSession(handle);
      return runtime.resumeSession(handle);
    },
    close: () => runtime.close(),
  };
}

function mergeIntoStringEnv(overrides: EnvVars | undefined): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[key] = value;
  }
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

function mergeIntoOptionalEnv(overrides: EnvVars | undefined): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

function ensureNodeInPath(env: Record<string, string | undefined>): void {
  const key = "PATH";
  const nodeDir = dirname(process.execPath);
  const sep = process.platform === "win32" ? ";" : ":";
  const current = typeof env[key] === "string" ? env[key] : "";
  const parts = current.split(sep).filter(Boolean);
  if (parts.includes(nodeDir)) return;
  env[key] = current ? `${nodeDir}${sep}${current}` : nodeDir;
}
