import { randomUUID } from "node:crypto"

import type { AgentMcpServer, SandboxSession } from "@aml-jsx/sdk"

import type { CapturedOpenCodeAgentOptions } from "./opencode-agent-options.js"
import { OpenCodeCapabilityAttachment } from "./opencode-capability-attachment.js"
import type {
  OpenCodeCapabilityAttachmentInput,
  OpenCodeModel,
  OpenCodeSessionClient,
  OpenCodeSessionCreateInput,
  OpenCodeSessionLocation,
  OpenCodeSessionPromptInput,
  OpenCodeSessionPromptResult,
} from "./opencode-session-client.js"

const OPENCODE_HOST_TOOLS = new Set(["bash", "edit", "glob", "grep", "list", "read", "write"])

interface OpenCodeSandboxSessionClientOptions {
  readonly config?: CapturedOpenCodeAgentOptions["config"]
  readonly sandbox: SandboxSession
}

/**
 * Maps OpenCode's non-interactive JSON CLI onto the existing session port.
 *
 * The CLI creates its server in the Sandbox process, so no port is exposed to
 * the local AML coordinator and the bounded runtime remains sufficient.
 */
export class OpenCodeSandboxSessionClient implements OpenCodeSessionClient {
  readonly #config: CapturedOpenCodeAgentOptions["config"]
  readonly #databaseRoot = `/tmp/aml-opencode-${randomUUID()}`
  readonly #sandbox: SandboxSession
  #capabilityTools: Readonly<Record<string, boolean>> | undefined
  #closed = false
  #mcp: Readonly<Record<string, unknown>> | undefined
  #realSessionId: string | undefined
  #sessionId: string | undefined
  #title: string | undefined

  constructor(options: OpenCodeSandboxSessionClientOptions) {
    this.#config = options.config
    this.#sandbox = options.sandbox
  }

  async abort(): Promise<void> {
    // The active runtime.exec() receives the evaluation AbortSignal. OpenCode's
    // CLI process is therefore cancelled by the Sandbox provider itself.
  }

  async attachCapabilities(
    input: OpenCodeCapabilityAttachmentInput,
    signal: AbortSignal
  ): Promise<OpenCodeCapabilityAttachment> {
    signal.throwIfAborted()

    if (input.structuredOutput) {
      throw new TypeError("OpenCode structured output is not yet transportable through AML Sandbox")
    }

    const tools: Record<string, boolean> = { "*": false }

    for (const tool of input.tools) {
      if (tool.kind === "javascript") {
        throw new TypeError("OpenCode JavaScript Tools are not yet transportable into AML Sandbox")
      }

      if (!OPENCODE_HOST_TOOLS.has(tool.name)) {
        throw new TypeError(`OpenCode host Tool "${tool.name}" is unsupported in AML Sandbox`)
      }

      tools[tool.name] = true
    }

    this.#capabilityTools = Object.freeze(tools)
    this.#mcp = captureMcpConfiguration(this.#config, input.mcpServers)
    return new OpenCodeCapabilityAttachment(this.#capabilityTools, async () => undefined)
  }

  async create(input: OpenCodeSessionCreateInput, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted()

    if (this.#sessionId !== undefined) {
      throw new Error("OpenCode Sandbox session client creates only one session")
    }

    this.#sessionId = `aml-${randomUUID()}`
    this.#title = input.title
    return this.#sessionId
  }

  async delete(input: OpenCodeSessionLocation): Promise<void> {
    this.#assertSession(input.sessionId)

    if (this.#closed) {
      return
    }

    this.#closed = true
    const result = await this.#sandbox.lease.runtime.exec("rm", ["-rf", "--", this.#databaseRoot], {
      cwd: this.#sandbox.cwd,
    })

    if (result.exitCode !== 0) {
      throw new Error(`OpenCode Sandbox cleanup failed: ${diagnostics(result.stderr, result.stdout)}`)
    }
  }

  async prompt(input: OpenCodeSessionPromptInput, signal: AbortSignal): Promise<OpenCodeSessionPromptResult> {
    this.#assertSession(input.sessionId)
    signal.throwIfAborted()

    if (this.#closed) {
      throw new Error("OpenCode Sandbox session is closed")
    }

    const tools = this.#capabilityTools

    if (tools === undefined) {
      throw new Error("OpenCode Sandbox capabilities must be attached before prompting")
    }

    const prepare = await this.#sandbox.lease.runtime.exec("mkdir", ["-p", "--", this.#databaseRoot], {
      cwd: this.#sandbox.cwd,
      signal,
    })

    if (prepare.exitCode !== 0) {
      throw new Error(`OpenCode Sandbox state setup failed: ${diagnostics(prepare.stderr, prepare.stdout)}`)
    }

    const args = ["run", "--format", "json", "--agent", "aml", "--title", this.#title ?? "AML"]
    const model = formatModel(input.model)

    if (model !== undefined) {
      args.push("--model", model)
    }

    if (this.#realSessionId !== undefined) {
      args.push("--session", this.#realSessionId)
    }

    args.push("--", input.prompt)
    const result = await this.#sandbox.lease.runtime.exec("opencode", args, {
      cwd: this.#sandbox.cwd,
      env: this.#environment(input.system, input.tools),
      signal,
    })

    if (result.exitCode !== 0) {
      throw new Error(
        `OpenCode Sandbox CLI exited with code ${result.exitCode}: ${diagnostics(result.stderr, result.stdout)}`
      )
    }

    const response = parseOpenCodeJson(result.stdout)
    this.#realSessionId = response.sessionId
    return Object.freeze({
      parts: Object.freeze([
        Object.freeze({
          text: response.text,
          type: "text",
        }),
      ]),
    })
  }

  #assertSession(sessionId: string): void {
    if (this.#sessionId === undefined || sessionId !== this.#sessionId) {
      throw new Error(`Unknown OpenCode Sandbox session "${sessionId}"`)
    }
  }

  #environment(system: string, tools: Readonly<Record<string, boolean>>): Readonly<Record<string, string>> {
    const defaults = {
      agent: Object.freeze({}),
      mcp: Object.freeze({}),
    }
    const userInputs = configTable(this.#config)
    const configured = {
      ...defaults,
      ...userInputs,
    }
    const configuredAgents = configTable(configured.agent)
    const permission: Record<string, "allow" | "deny"> = {
      external_directory: "deny",
      question: "deny",
      task: "deny",
      webfetch: "deny",
      websearch: "deny",
    }

    for (const [name, enabled] of Object.entries(tools)) {
      if (name !== "*" && enabled) {
        permission[name] = "allow"
      }
    }
    const imperativeConfig = {
      agent: {
        ...configuredAgents,
        aml: {
          mode: "primary",
          permission,
          prompt: system,
          tools,
        },
      },
      default_agent: "aml",
      mcp: this.#mcp,
      plugin: [],
      tools,
    }

    return Object.freeze({
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        ...configured,
        // These fields are AML's Sandbox capability boundary. Keep them in a
        // final bespoke layer so defu's array concatenation cannot re-enable
        // plugins or retain user-controlled values inside the aml Agent.
        ...imperativeConfig,
      }),
      OPENCODE_DB: `${this.#databaseRoot}/opencode.db`,
      XDG_CACHE_HOME: `${this.#databaseRoot}/cache`,
      XDG_CONFIG_HOME: `${this.#databaseRoot}/config`,
      XDG_DATA_HOME: `${this.#databaseRoot}/data`,
      XDG_STATE_HOME: `${this.#databaseRoot}/state`,
    })
  }
}

interface ParsedOpenCodeResponse {
  readonly sessionId: string
  readonly text: string
}

function parseOpenCodeJson(output: string): Readonly<ParsedOpenCodeResponse> {
  let sessionId: string | undefined
  const text: string[] = []
  const errors: string[] = []
  const diagnostics: string[] = []

  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim()

    if (trimmed.length === 0) {
      continue
    }

    let event: unknown

    try {
      event = JSON.parse(trimmed)
    } catch (cause) {
      // Daytona's command API combines stdout and stderr, so OpenCode's own
      // diagnostic logs can be interleaved with the JSON event stream.
      if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
        diagnostics.push(trimmed)
        continue
      }

      throw new Error(`OpenCode Sandbox CLI returned invalid JSON: ${line}`, { cause })
    }

    if (typeof event !== "object" || event === null) {
      throw new TypeError("OpenCode Sandbox CLI returned an invalid event")
    }

    const eventSessionId = Reflect.get(event, "sessionID")

    if (typeof eventSessionId === "string" && eventSessionId.length > 0) {
      if (sessionId !== undefined && sessionId !== eventSessionId) {
        throw new Error("OpenCode Sandbox CLI returned events for multiple sessions")
      }

      sessionId = eventSessionId
    }

    if (Reflect.get(event, "type") === "text") {
      const part = Reflect.get(event, "part")
      const value = typeof part === "object" && part !== null ? Reflect.get(part, "text") : undefined

      if (typeof value !== "string") {
        throw new TypeError("OpenCode Sandbox CLI returned an invalid text event")
      }

      text.push(value)
    }

    if (Reflect.get(event, "type") === "error") {
      errors.push(JSON.stringify(Reflect.get(event, "error") ?? "OpenCode session failed"))
    }
  }

  if (errors.length > 0) {
    throw new Error(`OpenCode Sandbox CLI failed: ${errors.join("\n")}`)
  }

  if (sessionId === undefined) {
    const detail = diagnostics.length === 0 ? "" : `: ${diagnostics.join("\n")}`
    throw new Error(`OpenCode Sandbox CLI returned no session id${detail}`)
  }

  return Object.freeze({
    sessionId,
    text: text.join(""),
  })
}

function captureMcpConfiguration(
  config: CapturedOpenCodeAgentOptions["config"],
  servers: readonly AgentMcpServer[]
): Readonly<Record<string, unknown>> {
  const supplied = configTable(configTable(config).mcp)
  const mcp: Record<string, unknown> = Object.fromEntries(
    Object.keys(supplied).map(name => [name, Object.freeze({ enabled: false })])
  )

  for (const server of servers) {
    if (server.kind === "named") {
      if (!Object.hasOwn(supplied, server.name)) {
        throw new Error(`OpenCode named MCP server "${server.name}" has no supplied configuration`)
      }

      mcp[server.name] = supplied[server.name]
      continue
    }

    const transport = server.definition.transport
    mcp[server.definition.name] =
      transport.type === "stdio"
        ? Object.freeze({
            command: Object.freeze([transport.command, ...(transport.args ?? [])]),
            cwd: transport.cwd,
            enabled: true,
            environment: transport.env,
            type: "local",
          })
        : Object.freeze({
            enabled: true,
            headers: transport.headers,
            type: "remote",
            url: transport.url,
          })
  }

  return Object.freeze(mcp)
}

function configTable(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : Object.freeze({})
}

function formatModel(model: OpenCodeModel | undefined): string | undefined {
  return model === undefined ? undefined : `${model.providerId}/${model.modelId}`
}

function diagnostics(stderr: string, stdout: string): string {
  const output = [stderr.trim(), stdout.trim()].filter(value => value.length > 0)
  return output.length === 0 ? "no command output" : output.join("\n")
}
