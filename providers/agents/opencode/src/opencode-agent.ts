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

export interface OpenCodeAgentProvider extends AgentProvider {
  readonly name: "opencode"
}

class OpenCodeAcpProfile implements AcpAgentProfile<"opencode"> {
  readonly name = "opencode"
  readonly #options: Readonly<CapturedOpenCodeAgentOptions>

  constructor(options: Readonly<CapturedOpenCodeAgentOptions>) {
    this.#options = options
  }

  get workingDirectory(): string | undefined {
    return this.#options.directory
  }

  createLaunch(context: Readonly<AcpAgentLaunchContext>): Readonly<AcpAgentLaunch> {
    const tools: Record<string, boolean> = { "*": true }
    const permission: Record<string, "allow" | "deny"> = { "*": "allow" }
    const inheritedPermission: Record<string, "deny"> = {}

    // OpenCode exposes more granular controls than ACP. Translate the portable
    // request here while the outer Sandbox remains the hard boundary.
    if (context.request.permissions.filesystem === "read-only") {
      tools.edit = false
      tools.write = false
      permission.edit = "deny"
      permission.write = "deny"
      inheritedPermission.edit = "deny"
    }

    if (!context.request.permissions.shell) {
      tools.bash = false
      permission.bash = "deny"
      inheritedPermission.bash = "deny"
    }

    if (!context.request.permissions.network) {
      tools.webfetch = false
      tools.websearch = false
      permission.webfetch = "deny"
      permission.websearch = "deny"
      inheritedPermission.webfetch = "deny"
      inheritedPermission.websearch = "deny"
    }

    const configuredAgents = configTable(this.#options.config.agent)
    const configuredPermission =
      typeof this.#options.config.permission === "string"
        ? { "*": this.#options.config.permission }
        : (this.#options.config.permission ?? {})
    const model = context.request.model ?? this.#options.model ?? this.#options.config.model
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
      ...(model === undefined ? {} : { model }),
    }

    return Object.freeze({
      args: ["acp", "--pure", "--cwd", context.cwd, ...this.#options.args],
      command: this.#options.command,
      env: {
        ...this.#options.env,
        OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
        OPENCODE_DB: `${context.stateDirectory}/opencode.db`,
        XDG_CACHE_HOME: `${context.stateDirectory}/cache`,
        XDG_CONFIG_HOME: `${context.stateDirectory}/config`,
        XDG_DATA_HOME: `${context.stateDirectory}/data`,
        XDG_STATE_HOME: `${context.stateDirectory}/state`,
      },
      ...(context.request.system.length === 0
        ? {}
        : { initialPromptPrefix: `<SYSTEM>\n${context.request.system}\n</SYSTEM>` }),
      permissionPolicy: "allow_always",
    })
  }
}

/**
 * Creates an OpenCode Agent through its native ACP server.
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
