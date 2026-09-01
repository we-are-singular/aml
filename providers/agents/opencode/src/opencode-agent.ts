import {
  defineAcpAgentProvider,
  type AcpAgentLaunch,
  type AcpAgentLaunchContext,
  type AcpAgentProfile,
  type AgentProvider,
} from "@aml-jsx/sdk"
import type { Config } from "@opencode-ai/sdk/v2"

import {
  captureOpenCodeAgentOptions,
  type CapturedOpenCodeAgentOptions,
  type OpenCodeAgentOptions,
} from "./opencode-agent-options.js"

/** Agent provider returned by {@link opencodeAgent}. */
export interface OpenCodeAgentProvider extends AgentProvider {
  /** Stable provider identifier reported in Agent requests and traces. */
  readonly name: "opencode"
}

class OpenCodeAcpProfile implements AcpAgentProfile<"opencode"> {
  readonly name = "opencode"
  readonly skillDiscovery = "native"
  readonly #options: Readonly<CapturedOpenCodeAgentOptions>

  constructor(options: Readonly<CapturedOpenCodeAgentOptions>) {
    this.#options = options
  }

  get workingDirectory(): string | undefined {
    return this.#options.directory
  }

  createLaunch(context: Readonly<AcpAgentLaunchContext>): Readonly<AcpAgentLaunch> {
    const configuration: NonNullable<AcpAgentLaunch["configuration"]>[number][] = []
    const initialPromptSections: string[] = []
    const deniedTools: Record<string, false> = {}
    const permission: Record<string, "allow" | "deny"> = { "*": "allow" }
    const inheritedPermission: Record<string, "deny"> = {}

    // OpenCode exposes more granular controls than ACP. Translate the portable
    // request here while the outer Sandbox remains the hard boundary.
    if (context.request.permissions.filesystem === "read-only") {
      deniedTools.edit = false
      deniedTools.write = false
      permission.edit = "deny"
      permission.write = "deny"
      inheritedPermission.edit = "deny"
    }

    if (!context.request.permissions.shell) {
      deniedTools.bash = false
      permission.bash = "deny"
      inheritedPermission.bash = "deny"
    }

    if (!context.request.permissions.network) {
      deniedTools.webfetch = false
      deniedTools.websearch = false
      permission.webfetch = "deny"
      permission.websearch = "deny"
      inheritedPermission.webfetch = "deny"
      inheritedPermission.websearch = "deny"
    }

    if (context.request.system.length > 0) {
      initialPromptSections.push(`<SYSTEM>\n${context.request.system}\n</SYSTEM>`)
    }

    if (context.amlMcpServerName !== undefined && context.request.tools.length > 0) {
      // OpenCode exposes MCP tools as <server>_<tool>. Name every generated
      // bridge Tool so the model can reliably address the authored capability.
      const toolMappings = context.request.tools
        .map(tool => `- ${tool.name}: ${context.amlMcpServerName}_${tool.name}`)
        .join("\n")
      initialPromptSections.push(`AML JavaScript Tools use these OpenCode MCP tool names:\n${toolMappings}`)
    }

    const configuredAgents = configTable(this.#options.config.agent)
    const configuredAmlAgent = configTable(configuredAgents.aml)
    const configuredAmlTools = configTable(configuredAmlAgent.tools) as Readonly<Record<string, boolean>>
    // Preserve native Tool choices from both OpenCode config layers, then let
    // AML's portable permission denials remain the final authority.
    const tools: Record<string, boolean> = {
      "*": true,
      ...this.#options.config.tools,
      ...configuredAmlTools,
      ...deniedTools,
    }
    const configuredPermission =
      typeof this.#options.config.permission === "string"
        ? { "*": this.#options.config.permission }
        : (this.#options.config.permission ?? {})
    const configuredSkills = configTable(this.#options.config.skills)
    const configuredSkillPaths = Array.isArray(configuredSkills.paths)
      ? configuredSkills.paths.filter((entry): entry is string => typeof entry === "string")
      : []
    const model = context.request.model ?? this.#options.model ?? this.#options.config.model
    if (model !== undefined) {
      // OpenCode ACP owns the session model after launch. File and environment
      // config alone leave the session on OpenCode's fallback model.
      configuration.push({ id: "model", value: model })
    }
    const config: Config = {
      ...this.#options.config,
      agent: {
        ...configuredAgents,
        aml: {
          mode: "primary",
          permission,
          tools,
        },
      },
      default_agent: "aml",
      // OpenCode merges top-level permissions into every native agent profile,
      // so task subagents receive the same portable AML restrictions.
      permission: { ...configuredPermission, ...inheritedPermission },
      ...(context.request.skills.length === 0
        ? {}
        : {
            skills: {
              ...configuredSkills,
              paths: [...configuredSkillPaths, ...context.request.skills.map(skill => skill.directory)],
            },
          }),
      ...(model === undefined ? {} : { model }),
    }

    return Object.freeze({
      args: ["acp", "--pure", "--cwd", context.cwd, ...this.#options.args],
      command: this.#options.command,
      configuration: Object.freeze(configuration),
      env: {
        ...this.#options.env,
        OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
        OPENCODE_DB: `${context.stateDirectory}/opencode.db`,
        XDG_CACHE_HOME: `${context.stateDirectory}/cache`,
        XDG_CONFIG_HOME: `${context.stateDirectory}/config`,
        // Callers may stage a request-local login while AML still owns every
        // other invocation-private OpenCode state directory.
        XDG_DATA_HOME: this.#options.env.XDG_DATA_HOME ?? `${context.stateDirectory}/data`,
        XDG_STATE_HOME: `${context.stateDirectory}/state`,
      },
      ...(initialPromptSections.length === 0 ? {} : { initialPromptPrefix: initialPromptSections.join("\n\n") }),
      permissionPolicy: "allow_always",
      ...(context.amlMcpServerName === undefined || context.request.output === undefined
        ? {}
        : {
            structuredOutputInstruction:
              `Call the OpenCode MCP tool "${context.amlMcpServerName}_aml_submit_result" once with the final value ` +
              "in its result field. If the tool returns an error, correct the result and retry the call. " +
              "After the tool accepts a result, do not call it again. Do not return substitute JSON only as message text.",
          }),
    })
  }
}

/**
 * Creates an OpenCode Agent through its native ACP server.
 *
 * The selected host or Sandbox must contain the configured OpenCode command.
 * Options are validated and captured before process acquisition. AML translates
 * portable permissions into OpenCode Tool and permission denials, while the
 * enclosing Sandbox remains the process-level enforcement boundary.
 *
 * @param options Native configuration, command, environment, model, and directory.
 */
export function opencodeAgent(options: OpenCodeAgentOptions = {}): Readonly<OpenCodeAgentProvider> {
  const profile = new OpenCodeAcpProfile(captureOpenCodeAgentOptions(options))
  return defineAcpAgentProvider(profile)
}

function configTable(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {}
}
