import {
  AcpAgentProvider,
  defineAgentProvider,
  type AcpAgentLaunch,
  type AcpAgentLaunchContext,
  type AcpAgentProfile,
  type AcpSessionFactory,
  type AgentProvider,
} from "@aml-jsx/sdk"

/** JSON configuration passed to the maintained Codex ACP adapter. */
export type CodexConfigValue =
  | boolean
  | number
  | string
  | null
  | readonly CodexConfigValue[]
  | Readonly<{ readonly [key: string]: CodexConfigValue }>

export interface CodexAgentOptions {
  readonly apiKey?: string
  readonly args?: readonly string[]
  readonly command?: string
  readonly config?: Readonly<Record<string, CodexConfigValue>>
  readonly env?: Readonly<Record<string, string>>
  readonly sessionFactory?: AcpSessionFactory
  readonly workingDirectory?: string
}

export interface CodexAgentProvider extends AgentProvider {
  readonly name: "codex"
}

interface CapturedCodexAgentOptions {
  readonly apiKey?: string
  readonly args: readonly string[]
  readonly command: string
  readonly config: Readonly<Record<string, CodexConfigValue>>
  readonly env: Readonly<Record<string, string>>
  readonly sessionFactory?: AcpSessionFactory
  readonly workingDirectory?: string
}

class CodexProfile implements AcpAgentProfile<"codex"> {
  readonly name = "codex"
  readonly #options: Readonly<CapturedCodexAgentOptions>

  constructor(options: Readonly<CapturedCodexAgentOptions>) {
    this.#options = options
  }

  get sessionFactory(): AcpSessionFactory | undefined {
    return this.#options.sessionFactory
  }

  get workingDirectory(): string | undefined {
    return this.#options.workingDirectory
  }

  createLaunch(context: Readonly<AcpAgentLaunchContext>): Readonly<AcpAgentLaunch> {
    const config = {
      ...this.#options.config,
      ...(context.request.model === undefined ? {} : { model: context.request.model }),
      ...(context.request.system.length === 0 ? {} : { developer_instructions: context.request.system }),
    }
    const hasApiKey =
      this.#options.apiKey !== undefined ||
      this.#options.env.CODEX_API_KEY !== undefined ||
      this.#options.env.OPENAI_API_KEY !== undefined
    const mode = context.request.permissions.filesystem === "read-only" ? "read-only" : "agent-full-access"

    return Object.freeze({
      args: this.#options.args,
      ...(hasApiKey ? { authenticationMethodId: "api-key" } : {}),
      command: this.#options.command,
      env: {
        CODEX_HOME: context.stateDirectory,
        ...this.#options.env,
        APP_SERVER_LOGS: `${context.stateDirectory}/logs`,
        CODEX_CONFIG: stringifyConfig(config),
        CODEX_PATH: "codex",
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

/**
 * Creates a Codex coding Agent through the maintained ACP adapter.
 *
 * The trusted host or selected Sandbox must contain `codex-acp` or the
 * configured command. AML never installs the adapter implicitly.
 */
export function codexAgent(options: CodexAgentOptions = {}): Readonly<CodexAgentProvider> {
  const profile = new CodexProfile(captureOptions(options))
  return defineAgentProvider(new AcpAgentProvider(profile))
}

function captureOptions(value: CodexAgentOptions): Readonly<CapturedCodexAgentOptions> {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Codex Agent options must be an object")
  }

  const command = normalizedString(value.command ?? "codex-acp", "Codex command")
  const args = value.args ?? []
  const env = value.env ?? {}
  const config = value.config ?? {}

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
    config: Object.freeze({ ...config }),
    env: Object.freeze({ ...env }),
    ...(value.sessionFactory === undefined ? {} : { sessionFactory: value.sessionFactory }),
    ...(value.workingDirectory === undefined
      ? {}
      : { workingDirectory: normalizedString(value.workingDirectory, "Codex workingDirectory") }),
  })
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
