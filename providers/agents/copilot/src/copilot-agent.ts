import {
  defineAcpAgentProvider,
  type AcpAgentLaunch,
  type AcpAgentLaunchContext,
  type AcpAgentProfile,
  type AgentProvider,
} from "@aml-jsx/sdk"

/** Reasoning levels accepted by GitHub Copilot CLI. */
export type CopilotReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"

const REASONING_EFFORTS = new Set<CopilotReasoningEffort>(["none", "minimal", "low", "medium", "high", "xhigh", "max"])
const AUTH_TOKEN_ENVIRONMENT_VARIABLES = ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"] as const

/** Configures GitHub Copilot CLI's native ACP server. */
export interface CopilotAgentOptions {
  readonly args?: readonly string[]
  readonly command?: string
  readonly env?: Readonly<Record<string, string>>
  readonly model?: string
  readonly reasoningEffort?: CopilotReasoningEffort
  readonly workingDirectory?: string
}

export interface CopilotAgentProvider extends AgentProvider {
  readonly name: "copilot"
}

interface CapturedCopilotAgentOptions {
  readonly args: readonly string[]
  readonly command: string
  readonly env: Readonly<Record<string, string>>
  readonly model: string
  readonly reasoningEffort?: CopilotReasoningEffort
  readonly workingDirectory?: string
}

class CopilotAcpProfile implements AcpAgentProfile<"copilot"> {
  readonly name = "copilot"
  readonly #options: Readonly<CapturedCopilotAgentOptions>

  constructor(options: Readonly<CapturedCopilotAgentOptions>) {
    this.#options = options
  }

  get workingDirectory(): string | undefined {
    return this.#options.workingDirectory
  }

  createLaunch(context: Readonly<AcpAgentLaunchContext>): Readonly<AcpAgentLaunch> {
    const excludedTools: string[] = []
    const initialPromptSections: string[] = []
    const permissionArgs: string[] = []

    // Explicit provider configuration owns authentication. Only local launches
    // may fall back to the host environment; Sandboxes discover their own env.
    const authTokenEnvironmentVariable =
      AUTH_TOKEN_ENVIRONMENT_VARIABLES.find(name => this.#options.env[name] !== undefined) ??
      (context.inheritsProcessEnvironment
        ? AUTH_TOKEN_ENVIRONMENT_VARIABLES.find(name => process.env[name] !== undefined)
        : undefined)

    if (context.request.permissions.filesystem === "read-only") {
      excludedTools.push("edit", "write")
      permissionArgs.push("--deny-tool=write")
    }

    if (!context.request.permissions.shell) {
      excludedTools.push("bash")
      permissionArgs.push("--deny-tool=shell")
    }

    if (!context.request.permissions.network) {
      excludedTools.push("web_fetch", "web_search")
      permissionArgs.push("--deny-tool=url")
    }

    if (excludedTools.length > 0) {
      permissionArgs.push("--excluded-tools", ...excludedTools)
    }

    if (context.request.system.length > 0) {
      // ACP has no system-message field. Preserve authored priority as an
      // explicit first-turn prelude while custom instructions remain disabled.
      initialPromptSections.push(`System instructions for this AML session:\n${context.request.system}`)
    }

    if (context.amlMcpServerName !== undefined && context.request.tools.length > 0) {
      // Copilot exposes session MCP tools as <server>-<tool>. Make authored AML
      // names explicit so the model can address the generated bridge reliably.
      const toolMappings = context.request.tools
        .map(tool => `- ${tool.name}: ${context.amlMcpServerName}-${tool.name}`)
        .join("\n")
      initialPromptSections.push(`AML JavaScript Tools use these Copilot MCP tool names:\n${toolMappings}`)
    }

    const model = context.request.model ?? this.#options.model

    return Object.freeze({
      args: Object.freeze([
        ...this.#options.args,
        "--acp",
        "--no-auto-update",
        `--log-dir=${context.stateDirectory}/logs`,
        "--no-custom-instructions",
        "--disable-builtin-mcps",
        "--no-ask-user",
        ...(authTokenEnvironmentVariable === undefined ? [] : [`--auth-token-env=${authTokenEnvironmentVariable}`]),
        "--no-auto-login",
        "--no-color",
        "--no-remote",
        "--no-remote-export",
        `--model=${model}`,
        ...(this.#options.reasoningEffort === undefined ? [] : [`--reasoning-effort=${this.#options.reasoningEffort}`]),
        ...permissionArgs,
      ]),
      command: this.#options.command,
      env: {
        ...this.#options.env,
        // Copilot's config directory can contain credentials, MCP servers,
        // permissions, and session state. Never inherit the operator's home.
        COPILOT_HOME: context.stateDirectory,
      },
      ...(initialPromptSections.length === 0 ? {} : { initialPromptPrefix: initialPromptSections.join("\n\n") }),
      // Explicit deny rules above take precedence over approvals. The outer
      // Sandbox remains the enforcement boundary for process-level authority.
      permissionPolicy: "allow_always",
      ...(context.amlMcpServerName === undefined || context.request.output === undefined
        ? {}
        : {
            structuredOutputInstruction:
              `Call the Copilot MCP tool "${context.amlMcpServerName}-aml_submit_result" once with the final value ` +
              "in its result field. If the tool returns an error, correct the result and retry the call. " +
              "After the tool accepts a result, do not call it again. Do not return substitute JSON only as message text.",
          }),
    })
  }
}

/**
 * Creates a GitHub Copilot Agent through Copilot CLI's native ACP server.
 *
 * The selected host or Sandbox must contain `copilot` or the configured
 * command. Authentication follows the launched process environment; AML does
 * not import the interactive user's Copilot configuration.
 */
export function copilotAgent(options: CopilotAgentOptions = {}): Readonly<CopilotAgentProvider> {
  const profile = new CopilotAcpProfile(captureOptions(options))
  return defineAcpAgentProvider(profile)
}

function captureOptions(options: CopilotAgentOptions): Readonly<CapturedCopilotAgentOptions> {
  if (typeof options !== "object" || options === null) {
    throw new TypeError("Copilot Agent options must be an object")
  }

  const args = options.args ?? []
  const command = normalizedString(options.command ?? "copilot", "Copilot command")
  const env = options.env ?? {}
  const model = normalizedString(options.model ?? "auto", "Copilot model")
  const reasoningEffort = options.reasoningEffort
  const workingDirectory = optionalNormalizedString(options.workingDirectory, "Copilot workingDirectory")

  if (!Array.isArray(args) || args.some(argument => typeof argument !== "string" || argument.includes("\0"))) {
    throw new TypeError("Copilot args must be strings without null bytes")
  }

  if (typeof env !== "object" || env === null || Array.isArray(env)) {
    throw new TypeError("Copilot env must be an object")
  }

  if (reasoningEffort !== undefined && !REASONING_EFFORTS.has(reasoningEffort)) {
    throw new TypeError("Copilot reasoningEffort is unsupported")
  }

  return Object.freeze({
    args: Object.freeze([...args]),
    command,
    env: Object.freeze({ ...env }),
    model,
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
