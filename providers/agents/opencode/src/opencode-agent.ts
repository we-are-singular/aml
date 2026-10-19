import {
  defineAcpAgentProvider,
  type AcpAgentLaunch,
  type AcpAgentLaunchContext,
  type AcpAgentProfile,
  type AgentProvider,
} from "@aml-jsx/sdk"
import type { Config } from "@opencode-ai/sdk/v2"
import path from "node:path"

import {
  captureOpenCodeAgentOptions,
  type CapturedOpenCodeAgentOptions,
  type OpenCodeAgentOptions,
} from "./opencode-agent-options.js"
import type { OpenCodeConfig } from "./opencode-config.js"

type OpenCodePermissions = Exclude<NonNullable<OpenCodeConfig["permission"]>, string>

// Only OpenCode needs these native directory exceptions. The runtime owns the
// private request association; other providers keep their existing behavior.
const AML_AGENT_STAGED_FILES = Symbol.for("@aml-jsx/sdk/agent-staged-files")

interface OpenCodeStagingGlobal {
  [AML_AGENT_STAGED_FILES]?: WeakMap<object, readonly string[]>
}

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

  get reservedMcpServerNames(): readonly string[] {
    return Object.keys(configTable(this.#options.config.mcp))
  }

  createLaunch(context: Readonly<AcpAgentLaunchContext>): Readonly<AcpAgentLaunch> {
    const configuration: NonNullable<AcpAgentLaunch["configuration"]>[number][] = []
    const initialPromptSections: string[] = []
    const permission: Record<string, "deny"> = {}
    const inheritedPermission: Record<string, "deny"> = {}

    // OpenCode exposes more granular controls than ACP. Translate the portable
    // request here while the outer Sandbox remains the hard boundary.
    if (context.request.permissions.filesystem === "read-only") {
      permission.edit = "deny"
      permission.write = "deny"
      inheritedPermission.edit = "deny"
    }

    if (!context.request.permissions.shell) {
      permission.bash = "deny"
      inheritedPermission.bash = "deny"
    }

    if (!context.request.permissions.network) {
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
    const configuredAmlAgent = { ...this.#options.config.agent?.aml }
    // A custom prompt replaces OpenCode's model-specific coding prompt.
    // AML System text instead travels in the initial ACP user turn.
    delete configuredAmlAgent.prompt
    const agentPermission = nativePermissions(configuredAmlAgent.tools, configuredAmlAgent.permission)
    const stagedFiles =
      (globalThis as typeof globalThis & OpenCodeStagingGlobal)[AML_AGENT_STAGED_FILES]?.get(context.request) ?? []
    const stagedDirectories = new Set([
      ...stagedFiles.map(file => path.posix.dirname(file.replaceAll("\\", "/"))),
      ...context.request.skills.map(skill => skill.directory.replaceAll("\\", "/")),
    ])

    if (stagedDirectories.size > 0) {
      // OpenCode asks for the containing directory's glob, even for one read.
      // Includes have unique directories; skills grant only their staged package.
      const external = agentPermission.external_directory
      delete agentPermission.external_directory
      agentPermission.external_directory = {
        ...(typeof external === "string" ? { "*": external } : external),
        ...Object.fromEntries(
          [...stagedDirectories].map(directory => [path.posix.join(directory, "*"), "allow" as const])
        ),
      }
    }
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
          ...configuredAmlAgent,
          mode: "primary",
          permission: nativePermissions(undefined, agentPermission, permission),
          tools: {},
        },
      },
      default_agent: "aml",
      // OpenCode merges top-level permissions into every native agent profile,
      // so task subagents receive the same portable AML restrictions.
      permission: nativePermissions(this.#options.config.tools, this.#options.config.permission, inheritedPermission),
      // Translate legacy tools ourselves so OpenCode cannot reinsert a wildcard
      // after native rules or alias a write setting over an AML edit denial.
      tools: {},
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

/** Resolves one native config layer while keeping portable denials last. */
function nativePermissions(
  tools: OpenCodeConfig["tools"],
  permission: OpenCodeConfig["permission"],
  denied: Readonly<Record<string, "deny">> = {}
): OpenCodePermissions {
  const rules: OpenCodePermissions = {}

  for (const [tool, enabled] of Object.entries(tools ?? {})) {
    const name = tool === "write" || tool === "patch" ? "edit" : tool
    rules[name] = enabled ? "allow" : "deny"
  }

  for (const [name, rule] of Object.entries(
    typeof permission === "string" ? { "*": permission } : (permission ?? {})
  )) {
    // OpenCode uses the last matching rule. Overwriting an object key would
    // retain its old position before a later wildcard, so reinsert it instead.
    delete rules[name]
    rules[name] = rule
  }

  for (const [name, rule] of Object.entries(denied)) {
    delete rules[name]
    rules[name] = rule
  }

  return rules
}
