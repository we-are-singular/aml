import type { AgentExecutionContext, AgentMcpServer, AgentRequest, AgentTool, AgentJavaScriptTool } from "@aml-jsx/sdk"

import type { CodexConfig, CodexConfigValue } from "./codex-client-factory.js"
import { CodexToolBridge } from "./codex-tool-bridge.js"

const CODEX_MCP_NAME = /^[A-Za-z0-9_-]+$/
const READ_ONLY_SHELL_TOOLS = new Set(["glob", "grep", "read"])

/**
 * Complete invocation-scoped capability configuration and cleanup boundary.
 */
export class CodexCapabilityAttachment {
  readonly #bridge: CodexToolBridge | undefined

  /**
   * MCP server overrides passed to the invocation-local Codex SDK client.
   */
  readonly mcpServers: Readonly<Record<string, CodexConfig>>

  /**
   * Provider-specific guidance required to discover deferred Codex MCP Tools.
   */
  readonly developerInstructions: string

  /**
   * Whether any authored host Tool grants Codex's read-only shell boundary.
   */
  readonly shellEnabled: boolean

  /**
   * Captures a fully started attachment after all capability preflight passes.
   */
  private constructor(options: {
    readonly bridge?: CodexToolBridge
    readonly developerInstructions: string
    readonly mcpServers: Readonly<Record<string, CodexConfig>>
    readonly shellEnabled: boolean
  }) {
    this.#bridge = options.bridge
    this.developerInstructions = options.developerInstructions
    this.mcpServers = options.mcpServers
    this.shellEnabled = options.shellEnabled
  }

  /**
   * Validates every grant before opening the JavaScript Tool bridge.
   */
  static async create(
    request: AgentRequest,
    context: AgentExecutionContext,
    suppliedMcpOverrides: Readonly<Record<string, CodexConfigValue>>
  ): Promise<CodexCapabilityAttachment> {
    const hostTools: AgentTool[] = []
    const javaScriptTools: AgentJavaScriptTool[] = []
    const toolNames = new Set<string>()

    // Host Tools and JavaScript Tools use different Codex mechanisms but share
    // one authored namespace. Duplicate names would make traces and grants
    // ambiguous even if the provider happened to accept them.
    for (const tool of request.tools) {
      if (toolNames.has(tool.name)) {
        throw new TypeError(`Codex Tool name "${tool.name}" is declared more than once`)
      }

      toolNames.add(tool.name)

      if (tool.kind === "host") {
        if (!READ_ONLY_SHELL_TOOLS.has(tool.name)) {
          throw new TypeError(`Codex host Tool "${tool.name}" is unsupported`)
        }

        hostTools.push(tool)
        continue
      }

      // MCP Tool declarations require an object-root input schema. Reject the
      // mismatch before binding a server or starting a Codex thread.
      if (tool.inputSchema.type !== "object") {
        throw new TypeError(`Codex Tool "${tool.name}" requires an object input schema`)
      }

      javaScriptTools.push(tool)
    }

    const mcpServerEntries: Array<readonly [string, CodexConfig]> = []
    const declaredNames = new Set<string>()

    for (const server of request.mcpServers) {
      const name = server.kind === "named" ? server.name : server.definition.name

      CodexCapabilityAttachment.#validateMcpName(name)

      if (declaredNames.has(name)) {
        throw new TypeError(`Codex MCP server "${name}" is declared more than once`)
      }

      declaredNames.add(name)
      mcpServerEntries.push([name, CodexCapabilityAttachment.#serverConfig(server, suppliedMcpOverrides)])
    }

    const developerInstructions = CodexCapabilityAttachment.#developerInstructions(javaScriptTools, request.mcpServers)

    if (javaScriptTools.length === 0) {
      return new CodexCapabilityAttachment({
        developerInstructions,
        // Object.fromEntries preserves names such as "__proto__" as ordinary
        // data properties instead of invoking Object.prototype setters.
        mcpServers: Object.freeze(Object.fromEntries(mcpServerEntries)),
        shellEnabled: hostTools.length > 0,
      })
    }

    const bridge = new CodexToolBridge(javaScriptTools, context)
    const connection = await bridge.start(context.signal)

    if (declaredNames.has(connection.name) || Object.hasOwn(suppliedMcpOverrides, connection.name)) {
      try {
        await bridge.close()
      } catch (cleanupError) {
        throw new AggregateError(
          [new TypeError(`Codex Tool bridge name "${connection.name}" collides with MCP configuration`), cleanupError],
          "Codex Tool bridge collision and cleanup failed"
        )
      }

      throw new TypeError(`Codex Tool bridge name "${connection.name}" collides with MCP configuration`)
    }

    mcpServerEntries.push([
      connection.name,
      Object.freeze({
        default_tools_approval_mode: "approve",
        enabled: true,
        enabled_tools: Object.freeze(javaScriptTools.map(tool => tool.name)),
        http_headers: Object.freeze({
          ...connection.headers,
        }),
        required: true,
        url: connection.url,
      }),
    ])

    return new CodexCapabilityAttachment({
      bridge,
      developerInstructions,
      mcpServers: Object.freeze(Object.fromEntries(mcpServerEntries)),
      shellEnabled: hostTools.length > 0,
    })
  }

  /**
   * Releases the invocation Tool bridge after the complete thread settles.
   */
  async close(): Promise<void> {
    await this.#bridge?.close()
  }

  /**
   * Maps one portable MCP grant into Codex configuration.
   */
  static #serverConfig(
    server: AgentMcpServer,
    suppliedMcpOverrides: Readonly<Record<string, CodexConfigValue>>
  ): CodexConfig {
    const common = {
      default_tools_approval_mode: "approve",
      enabled: true,
      required: true,
    } as const

    if (server.kind === "named") {
      // This supplied table excludes ambient repository and user Codex
      // configuration. When absent here, required:true lets the real CLI
      // resolve the exact host-owned name or reject the missing capability.
      if (!Object.hasOwn(suppliedMcpOverrides, server.name)) {
        return Object.freeze(common)
      }

      const suppliedOverride = suppliedMcpOverrides[server.name]

      // Presence is materially different from absence at this authority
      // boundary. Never reinterpret malformed explicit configuration as an
      // ambient server with the same name.
      if (typeof suppliedOverride !== "object" || suppliedOverride === null || Array.isArray(suppliedOverride)) {
        throw new TypeError(`Codex MCP server "${server.name}" configuration must be an object`)
      }

      return Object.freeze({
        // The checks above exclude readonly arrays at runtime even though
        // Array.isArray() does not narrow them from this recursive union.
        ...(suppliedOverride as CodexConfig),
        ...common,
      })
    }

    const transport = server.definition.transport

    if (transport.type === "stdio") {
      return Object.freeze({
        args: Object.freeze([...(transport.args ?? [])]),
        command: transport.command,
        ...common,
        ...(transport.cwd === undefined ? {} : { cwd: transport.cwd }),
        ...(transport.env === undefined ? {} : { env: Object.freeze({ ...transport.env }) }),
      })
    }

    return Object.freeze({
      ...common,
      ...(transport.headers === undefined
        ? {}
        : {
            http_headers: Object.freeze({
              ...transport.headers,
            }),
          }),
      url: transport.url,
    })
  }

  /**
   * Enforces names that survive the SDK's dotted config serialization.
   */
  static #validateMcpName(name: string): void {
    if (!CODEX_MCP_NAME.test(name)) {
      throw new TypeError(`Codex MCP server name "${name}" must contain only letters, digits, "_" or "-"`)
    }
  }

  /**
   * Tells Codex how to find invocation Tools hidden by deferred discovery.
   */
  static #developerInstructions(tools: readonly AgentJavaScriptTool[], servers: readonly AgentMcpServer[]): string {
    const sections: string[] = []

    if (tools.length > 0) {
      const declarations = tools.map(tool => `- ${tool.name}: ${tool.description}`).join("\n")

      sections.push(
        [
          "AML granted these exact JavaScript Tools through an invocation-local MCP server:",
          declarations,
          "When the requested Tool is deferred, use Codex tool discovery with its exact name, then call it. Do not substitute repository search, shell commands, or another similarly named capability.",
        ].join("\n")
      )
    }

    if (servers.length > 0) {
      sections.push(
        `AML granted these MCP server names for this Agent: ${servers
          .map(server => (server.kind === "named" ? server.name : server.definition.name))
          .join(", ")}.`
      )
    }

    return sections.join("\n")
  }
}
