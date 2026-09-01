import {
  defineAcpAgentProvider,
  type AcpAgentLaunch,
  type AcpAgentLaunchContext,
  type AcpAgentProfile,
  type AgentProvider,
} from "@aml-jsx/sdk"
import path from "node:path"

/** JSON configuration passed to the maintained Codex ACP adapter. */
export type CodexConfigValue =
  | boolean
  | number
  | string
  | null
  | readonly CodexConfigValue[]
  | Readonly<{
      /** Stores one nested Codex configuration value under its authored key. */
      readonly [key: string]: CodexConfigValue
    }>

/**
 * Configures the maintained Codex ACP adapter and the Codex process it launches.
 *
 * Options are validated and snapshotted when {@link codexAgent} is called, so
 * later mutations to arrays or objects do not alter the provider.
 */
export interface CodexAgentOptions {
  /**
   * API key written to `CODEX_API_KEY` for the launched session.
   *
   * Omit to use credentials from `env` or the adapter's own supported flow. An
   * explicit value overrides `env.CODEX_API_KEY` and selects ACP's `api-key`
   * authentication method.
   */
  readonly apiKey?: string

  /**
   * Arguments appended to the ACP adapter command exactly as supplied.
   *
   * Defaults to `[]`. Entries may be empty but cannot contain null bytes.
   */
  readonly args?: readonly string[]

  /**
   * ACP adapter executable or application-owned launcher.
   *
   * Defaults to `"codex-acp"`. AML does not install or resolve the adapter.
   */
  readonly command?: string

  /**
   * Codex executable path exposed to the adapter as `CODEX_PATH`.
   *
   * Defaults to `"codex"`. This does not replace the outer `command` that
   * starts the ACP adapter.
   */
  readonly codexPathOverride?: string

  /**
   * Base Codex configuration serialized into `CODEX_CONFIG`.
   *
   * Defaults to `{}` and must be JSON-serializable. The effective model,
   * reasoning effort, and AML system instructions are applied afterward and
   * therefore override the corresponding base keys when present.
   */
  readonly config?: Readonly<Record<string, CodexConfigValue>>

  /**
   * Additional environment variables for the launched adapter.
   *
   * Defaults to `{}`. AML-owned session isolation and launch variables are
   * written after this object and cannot be overridden through it.
   */
  readonly env?: Readonly<Record<string, string>>

  /**
   * Provider-level model fallback.
   *
   * Omit to let Codex select its configured default. An `<Agent model>` prop
   * takes precedence for that Agent session.
   */
  readonly model?: string

  /**
   * Provider-native value written to Codex `model_reasoning_effort`.
   *
   * Omitted by default. AML validates only that the string is normalized and
   * forwards it without maintaining an allowlist.
   */
  readonly reasoningEffort?: string

  /**
   * Fallback working directory for host execution.
   *
   * Omit to inherit the application directory. An active Sandbox supplies the
   * effective directory instead.
   */
  readonly workingDirectory?: string
}

/** Agent provider returned by {@link codexAgent}. */
export interface CodexAgentProvider extends AgentProvider {
  /** Stable provider identifier reported in Agent requests and traces. */
  readonly name: "codex"
}

interface CapturedCodexAgentOptions {
  readonly apiKey?: string
  readonly args: readonly string[]
  readonly command: string
  readonly codexPathOverride?: string
  readonly config: Readonly<Record<string, CodexConfigValue>>
  readonly env: Readonly<Record<string, string>>
  readonly model?: string
  readonly reasoningEffort?: string
  readonly workingDirectory?: string
}

class CodexProfile implements AcpAgentProfile<"codex"> {
  readonly name = "codex"
  readonly skillDiscovery = "native"
  readonly #options: Readonly<CapturedCodexAgentOptions>

  constructor(options: Readonly<CapturedCodexAgentOptions>) {
    this.#options = options
  }

  get workingDirectory(): string | undefined {
    return this.#options.workingDirectory
  }

  createLaunch(context: Readonly<AcpAgentLaunchContext>): Readonly<AcpAgentLaunch> {
    const model = context.request.model ?? this.#options.model
    const config = {
      ...this.#options.config,
      ...(this.#options.reasoningEffort === undefined ? {} : { model_reasoning_effort: this.#options.reasoningEffort }),
      ...(model === undefined ? {} : { model }),
      ...(context.request.system.length === 0 ? {} : { developer_instructions: context.request.system }),
    }
    const hasApiKey =
      this.#options.apiKey !== undefined ||
      this.#options.env.CODEX_API_KEY !== undefined ||
      this.#options.env.OPENAI_API_KEY !== undefined
    const mode = context.request.permissions.filesystem === "read-only" ? "read-only" : "agent-full-access"
    const skillHome = codexSkillHome(context)

    return Object.freeze({
      args: this.#options.args,
      ...(hasApiKey ? { authenticationMethodId: "api-key" } : {}),
      command: this.#options.command,
      env: {
        ...this.#options.env,
        APP_SERVER_LOGS: `${context.stateDirectory}/logs`,
        CODEX_CONFIG: stringifyConfig(config),
        CODEX_HOME: skillHome ?? context.stateDirectory,
        CODEX_PATH: this.#options.codexPathOverride ?? "codex",
        CODEX_SQLITE_HOME: context.stateDirectory,
        INITIAL_AGENT_MODE: mode,
        NO_BROWSER: "1",
        ...(this.#options.apiKey === undefined ? {} : { CODEX_API_KEY: this.#options.apiKey }),
      },
      // Codex ACP currently expresses filesystem access as a mode. Shell and
      // network restrictions still rely on the enclosing Sandbox boundary.
      permissionPolicy: mode === "agent-full-access" ? "allow_always" : "allow_once",
    })
  }
}

function codexSkillHome(context: Readonly<AcpAgentLaunchContext>): string | undefined {
  const homes = new Set(context.request.skills.map(skill => path.dirname(path.dirname(skill.directory))))

  if (homes.size > 1) {
    throw new Error("Codex Agent Skills must share one staging root")
  }

  return homes.values().next().value
}

/**
 * Creates a Codex coding Agent through the maintained ACP adapter.
 *
 * The trusted host or selected Sandbox must contain `codex-acp` or the
 * configured command. AML never installs the adapter implicitly.
 * Configuration is validated and captured before any process or Sandbox work.
 *
 * @param options Adapter command, credentials, Codex configuration, and defaults.
 */
export function codexAgent(options: CodexAgentOptions = {}): Readonly<CodexAgentProvider> {
  const profile = new CodexProfile(captureOptions(options))
  return defineAcpAgentProvider(profile)
}

function captureOptions(value: CodexAgentOptions): Readonly<CapturedCodexAgentOptions> {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Codex Agent options must be an object")
  }

  const command = normalizedString(value.command ?? "codex-acp", "Codex command")
  const args = value.args ?? []
  const env = value.env ?? {}
  const config = value.config ?? {}
  const codexPathOverride = optionalNormalizedString(value.codexPathOverride, "Codex codexPathOverride")
  const model = optionalNormalizedString(value.model, "Codex model")
  const reasoningEffort = optionalNormalizedString(value.reasoningEffort, "Codex reasoningEffort")

  if (!Array.isArray(args) || args.some(argument => typeof argument !== "string" || argument.includes("\0"))) {
    throw new TypeError("Codex args must be strings without null bytes")
  }

  if (typeof env !== "object" || env === null || Array.isArray(env)) {
    throw new TypeError("Codex env must be an object")
  }

  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    throw new TypeError("Codex config must be an object")
  }

  // Validate serialization before Sandbox acquisition performs external work.
  stringifyConfig(config)

  return Object.freeze({
    ...(value.apiKey === undefined ? {} : { apiKey: normalizedString(value.apiKey, "Codex apiKey") }),
    args: Object.freeze([...args]),
    command,
    ...(codexPathOverride === undefined ? {} : { codexPathOverride }),
    config: Object.freeze({ ...config }),
    env: Object.freeze({ ...env }),
    ...(model === undefined ? {} : { model }),
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    ...(value.workingDirectory === undefined
      ? {}
      : { workingDirectory: normalizedString(value.workingDirectory, "Codex workingDirectory") }),
  })
}

function optionalNormalizedString(value: string | undefined, label: string): string | undefined {
  return value === undefined ? undefined : normalizedString(value, label)
}

function stringifyConfig(value: Readonly<Record<string, CodexConfigValue>>): string {
  try {
    return JSON.stringify(value)
  } catch (cause) {
    throw new TypeError("Codex config must be JSON serializable", { cause })
  }
}

function normalizedString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim() || value.includes("\0")) {
    throw new TypeError(`${label} must be a non-empty normalized string`)
  }

  return value
}
