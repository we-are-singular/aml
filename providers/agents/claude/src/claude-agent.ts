import {
  defineAcpAgentProvider,
  type AcpAgentLaunch,
  type AcpAgentLaunchContext,
  type AcpAgentProfile,
  type AgentProvider,
} from "@aml-jsx/sdk"

/**
 * Configures the maintained Claude Agent ACP adapter and the Claude Code
 * process it starts through the Claude Agent SDK.
 *
 * Options are validated and snapshotted when {@link claudeAgent} is called, so
 * later mutations to arrays or objects do not alter the provider.
 */
export interface ClaudeAgentOptions {
  /**
   * Anthropic API key written to `ANTHROPIC_API_KEY` for the launched session.
   *
   * Omit to use `env`, or the host environment for local launches. An explicit
   * value overrides `env.ANTHROPIC_API_KEY`. Cannot be combined with
   * `oauthToken`.
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
   * Defaults to `"claude-agent-acp"`. AML does not install or resolve the
   * adapter.
   */
  readonly command?: string

  /**
   * Additional environment variables for the launched adapter.
   *
   * Defaults to `{}`. AML-owned credential, model, and private-state variables
   * are written after this object and take precedence when present.
   */
  readonly env?: Readonly<Record<string, string>>

  /**
   * Provider-level model fallback written to `ANTHROPIC_MODEL`.
   *
   * Omit to let Claude Code select its default. An `<Agent model>` prop takes
   * precedence. Aliases such as `"sonnet"` and full model ids are resolved by
   * the adapter and Claude Code.
   */
  readonly model?: string

  /**
   * Claude Code OAuth token written to `CLAUDE_CODE_OAUTH_TOKEN`.
   *
   * Create one with `claude setup-token`. An explicit value overrides
   * `env.CLAUDE_CODE_OAUTH_TOKEN`. Cannot be combined with `apiKey`.
   */
  readonly oauthToken?: string

  /**
   * Provider-native Claude Agent SDK `effort` value.
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

/** Agent provider returned by {@link claudeAgent}. */
export interface ClaudeAgentProvider extends AgentProvider {
  /** Stable provider identifier reported in Agent requests and traces. */
  readonly name: "claude"
}

interface CapturedClaudeAgentOptions {
  readonly apiKey?: string
  readonly args: readonly string[]
  readonly command: string
  readonly env: Readonly<Record<string, string>>
  readonly model?: string
  readonly oauthToken?: string
  readonly reasoningEffort?: string
  readonly workingDirectory?: string
}

class ClaudeAcpProfile implements AcpAgentProfile<"claude"> {
  readonly name = "claude"
  readonly skillDiscovery = "native"
  readonly #options: Readonly<CapturedClaudeAgentOptions>

  constructor(options: Readonly<CapturedClaudeAgentOptions>) {
    this.#options = options
  }

  get workingDirectory(): string | undefined {
    return this.#options.workingDirectory
  }

  createLaunch(context: Readonly<AcpAgentLaunchContext>): Readonly<AcpAgentLaunch> {
    const disallowedTools: string[] = []
    const systemSections: string[] = []

    // Claude Code removes disallowed tools from the model's tool set, including
    // for its subagents. The outer Sandbox remains the process-level boundary.
    if (context.request.permissions.filesystem === "read-only") {
      disallowedTools.push("Edit", "Write", "NotebookEdit")
    }

    if (!context.request.permissions.shell) {
      disallowedTools.push("Bash")
    }

    if (!context.request.permissions.network) {
      disallowedTools.push("WebFetch", "WebSearch")
    }

    if (context.request.system.length > 0) {
      systemSections.push(context.request.system)
    }

    const serverName = context.amlMcpServerName
    if (serverName !== undefined && context.request.tools.length > 0) {
      // Claude Code exposes MCP tools as mcp__<server>__<tool>. Name every
      // generated bridge Tool so the model can address the authored capability.
      const toolMappings = context.request.tools
        .map(tool => `- ${tool.name}: ${claudeMcpToolName(serverName, tool.name)}`)
        .join("\n")
      systemSections.push(`AML JavaScript Tools use these Claude Code MCP tool names:\n${toolMappings}`)
    }

    const sdkOptions = {
      ...(disallowedTools.length === 0 ? {} : { disallowedTools }),
      ...(this.#options.reasoningEffort === undefined ? {} : { effort: this.#options.reasoningEffort }),
    }
    const sessionMeta = {
      // An object prompt keeps Claude Code's preset and appends AML's
      // instructions to the real system prompt instead of the first turn.
      ...(systemSections.length === 0 ? {} : { systemPrompt: { append: systemSections.join("\n\n") } }),
      ...(Object.keys(sdkOptions).length === 0 ? {} : { claudeCode: { options: sdkOptions } }),
    }
    const model = context.request.model ?? this.#options.model
    // Staged Skills already use Claude's <config>/skills/<name>/SKILL.md layout.
    const configDirectory = context.request.skills[0]?.skillHome ?? context.stateDirectory

    return Object.freeze({
      args: this.#options.args,
      command: this.#options.command,
      env: {
        ...this.#options.env,
        ...(model === undefined ? {} : { ANTHROPIC_MODEL: model }),
        ...(this.#options.apiKey === undefined ? {} : { ANTHROPIC_API_KEY: this.#options.apiKey }),
        ...(this.#options.oauthToken === undefined ? {} : { CLAUDE_CODE_OAUTH_TOKEN: this.#options.oauthToken }),
        // Claude Code's config directory holds settings, credentials, skills,
        // and transcripts. Never read or write the operator's ~/.claude.
        CLAUDE_CONFIG_DIR: configDirectory,
        // The adapter and CLI still resolve a few paths through the home
        // directory, so it must be invocation-private as well.
        HOME: context.stateDirectory,
      },
      // "allow_always" would persist a rule into the project's
      // .claude/settings.local.json. Approve each request without side effects.
      permissionPolicy: "allow_once",
      ...(Object.keys(sessionMeta).length === 0 ? {} : { sessionMeta }),
      ...(serverName === undefined || context.request.output === undefined
        ? {}
        : {
            structuredOutputInstruction:
              `Call the Claude Code MCP tool "${claudeMcpToolName(serverName, "aml_submit_result")}" ` +
              "once with the final value in its result field. If the tool returns an error, correct the result and " +
              "retry the call. After the tool accepts a result, do not call it again. Do not return substitute JSON " +
              "only as message text.",
          }),
    })
  }
}

/**
 * Creates a Claude coding Agent through the maintained Claude Agent ACP adapter.
 *
 * The trusted host or selected Sandbox must contain `claude-agent-acp` or the
 * configured command. AML never installs the adapter implicitly, and it never
 * imports the interactive user's Claude Code configuration or login state.
 * Configuration is validated and captured before any process or Sandbox work.
 *
 * AML maps portable permission denials onto Claude Code's disallowed tools,
 * while the enclosing Sandbox remains the process-level enforcement boundary.
 *
 * @param options Adapter command, credentials, environment, model, and defaults.
 */
export function claudeAgent(options: ClaudeAgentOptions = {}): Readonly<ClaudeAgentProvider> {
  const profile = new ClaudeAcpProfile(captureOptions(options))
  return defineAcpAgentProvider(profile)
}

function claudeMcpToolName(serverName: string, toolName: string): string {
  return `mcp__${serverName}__${toolName}`
}

function captureOptions(value: ClaudeAgentOptions): Readonly<CapturedClaudeAgentOptions> {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Claude Agent options must be an object")
  }

  const command = normalizedString(value.command ?? "claude-agent-acp", "Claude command")
  const args = value.args ?? []
  const env = value.env ?? {}
  const apiKey = optionalNormalizedString(value.apiKey, "Claude apiKey")
  const model = optionalNormalizedString(value.model, "Claude model")
  const oauthToken = optionalNormalizedString(value.oauthToken, "Claude oauthToken")
  const reasoningEffort = optionalNormalizedString(value.reasoningEffort, "Claude reasoningEffort")
  const workingDirectory = optionalNormalizedString(value.workingDirectory, "Claude workingDirectory")

  if (!Array.isArray(args) || args.some(argument => typeof argument !== "string" || argument.includes("\0"))) {
    throw new TypeError("Claude args must be strings without null bytes")
  }

  if (typeof env !== "object" || env === null || Array.isArray(env)) {
    throw new TypeError("Claude env must be an object")
  }

  if (apiKey !== undefined && oauthToken !== undefined) {
    throw new TypeError("Claude apiKey and oauthToken cannot both be set")
  }

  return Object.freeze({
    ...(apiKey === undefined ? {} : { apiKey }),
    args: Object.freeze([...args]),
    command,
    env: Object.freeze({ ...env }),
    ...(model === undefined ? {} : { model }),
    ...(oauthToken === undefined ? {} : { oauthToken }),
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    ...(workingDirectory === undefined ? {} : { workingDirectory }),
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
