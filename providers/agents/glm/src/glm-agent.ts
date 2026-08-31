import {
  defineAcpAgentProvider,
  type AcpAgentLaunch,
  type AcpAgentLaunchContext,
  type AcpAgentProfile,
  type AgentProvider,
} from "@aml-jsx/sdk"

/**
 * Configures the community-maintained GLM ACP adapter and Coding Plan request.
 */
export interface GlmAgentOptions {
  /**
   * Z.AI Coding Plan API key written to `Z_AI_API_KEY`.
   *
   * Omit to supply `env.Z_AI_API_KEY`. An explicit value takes precedence and
   * advertises the adapter's `z-ai-api-key` authentication method.
   */
  readonly apiKey?: string

  /**
   * Arguments appended to the adapter command exactly as supplied.
   *
   * Defaults to `[]`; entries cannot contain null bytes.
   */
  readonly args?: readonly string[]

  /**
   * Coding Plan endpoint written to `ACP_GLM_BASE_URL`.
   *
   * Omit to use the adapter's default endpoint.
   */
  readonly baseUrl?: string

  /**
   * ACP adapter executable or application-owned launcher.
   *
   * Defaults to `"glm-acp-agent"`. AML does not install the adapter.
   */
  readonly command?: string

  /**
   * Additional environment variables for the adapter process.
   *
   * Defaults to `{}`. AML-owned key, endpoint, model, token-limit, and private
   * session variables are written afterward and take precedence when present.
   */
  readonly env?: Readonly<Record<string, string>>

  /**
   * Positive safe-integer completion limit written to `ACP_GLM_MAX_TOKENS`.
   *
   * Omit to use the adapter default, currently 8192 tokens.
   */
  readonly maxTokens?: number

  /**
   * Provider-level model fallback written to `ACP_GLM_MODEL`.
   *
   * Omit to use the adapter's default. An `<Agent model>` prop takes precedence.
   */
  readonly model?: string

  /**
   * Fallback working directory when no active Sandbox supplies one.
   *
   * Omit to use the application working directory.
   */
  readonly workingDirectory?: string
}

/** Agent provider returned by {@link glmAgent}. */
export interface GlmAgentProvider extends AgentProvider {
  /** Stable provider identifier reported in Agent requests and traces. */
  readonly name: "glm"
}

interface CapturedGlmAgentOptions {
  readonly apiKey?: string
  readonly args: readonly string[]
  readonly baseUrl?: string
  readonly command: string
  readonly env: Readonly<Record<string, string>>
  readonly maxTokens?: number
  readonly model?: string
  readonly workingDirectory?: string
}

class GlmAcpProfile implements AcpAgentProfile<"glm"> {
  readonly name = "glm"
  readonly #options: Readonly<CapturedGlmAgentOptions>

  constructor(options: Readonly<CapturedGlmAgentOptions>) {
    this.#options = options
  }

  get workingDirectory(): string | undefined {
    return this.#options.workingDirectory
  }

  createLaunch(context: Readonly<AcpAgentLaunchContext>): Readonly<AcpAgentLaunch> {
    const model = context.request.model ?? this.#options.model
    const hasApiKey = this.#options.apiKey !== undefined || this.#options.env.Z_AI_API_KEY !== undefined

    return Object.freeze({
      args: this.#options.args,
      ...(hasApiKey ? { authenticationMethodId: "z-ai-api-key" } : {}),
      command: this.#options.command,
      env: {
        ...this.#options.env,
        ...(this.#options.apiKey === undefined ? {} : { Z_AI_API_KEY: this.#options.apiKey }),
        ...(this.#options.baseUrl === undefined ? {} : { ACP_GLM_BASE_URL: this.#options.baseUrl }),
        ...(this.#options.maxTokens === undefined ? {} : { ACP_GLM_MAX_TOKENS: String(this.#options.maxTokens) }),
        ...(model === undefined ? {} : { ACP_GLM_MODEL: model }),
        // The adapter persists resumable sessions under XDG state by default.
        // Keep that state invocation-private alongside AML's session directory.
        ACP_GLM_SESSION_DIR: `${context.stateDirectory}/sessions`,
      },
      ...(context.request.system.length === 0
        ? {}
        : { initialPromptPrefix: `<SYSTEM>\n${context.request.system}\n</SYSTEM>` }),
      // glm-acp-agent exposes no portable permission surface beyond protocol
      // requests. The enclosing Sandbox remains the boundary for filesystem,
      // shell, and network restrictions.
      permissionPolicy: context.request.permissions.filesystem === "read-only" ? "allow_once" : "allow_always",
    })
  }
}

/**
 * Creates a GLM coding Agent through the registry-listed glm-acp-agent adapter.
 *
 * The trusted host or selected Sandbox must contain `glm-acp-agent` or the
 * configured command, plus a Z.AI Coding Plan API key. AML never installs the
 * adapter implicitly. This adapter is community-maintained and is not the
 * Z.ai ZCode harness; ZCode has no ACP implementation today.
 *
 * The adapter does not expose portable shell or network restrictions; use an
 * enforcing Sandbox when those permissions are security requirements.
 *
 * @param options Adapter command, Coding Plan settings, environment, and defaults.
 */
export function glmAgent(options: GlmAgentOptions = {}): Readonly<GlmAgentProvider> {
  const profile = new GlmAcpProfile(captureOptions(options))
  return defineAcpAgentProvider(profile)
}

function captureOptions(value: GlmAgentOptions): Readonly<CapturedGlmAgentOptions> {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("GLM Agent options must be an object")
  }

  const command = normalizedString(value.command ?? "glm-acp-agent", "GLM command")
  const args = value.args ?? []
  const env = value.env ?? {}
  const apiKey = optionalNormalizedString(value.apiKey, "GLM apiKey")
  const baseUrl = optionalNormalizedString(value.baseUrl, "GLM baseUrl")
  const model = optionalNormalizedString(value.model, "GLM model")
  const maxTokens = value.maxTokens

  if (!Array.isArray(args) || args.some(argument => typeof argument !== "string" || argument.includes("\0"))) {
    throw new TypeError("GLM args must be strings without null bytes")
  }

  if (typeof env !== "object" || env === null || Array.isArray(env)) {
    throw new TypeError("GLM env must be an object")
  }

  if (maxTokens !== undefined && (!Number.isSafeInteger(maxTokens) || maxTokens < 1)) {
    throw new TypeError("GLM maxTokens must be a positive safe integer")
  }

  return Object.freeze({
    ...(apiKey === undefined ? {} : { apiKey }),
    args: Object.freeze([...args]),
    ...(baseUrl === undefined ? {} : { baseUrl }),
    command,
    env: Object.freeze({ ...env }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
    ...(model === undefined ? {} : { model }),
    ...(value.workingDirectory === undefined
      ? {}
      : { workingDirectory: normalizedString(value.workingDirectory, "GLM workingDirectory") }),
  })
}

function optionalNormalizedString(value: string | undefined, label: string): string | undefined {
  return value === undefined ? undefined : normalizedString(value, label)
}

function normalizedString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim() || value.includes("\0")) {
    throw new TypeError(`${label} must be a non-empty normalized string`)
  }

  return value
}
