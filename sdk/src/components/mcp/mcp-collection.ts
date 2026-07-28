import { EvaluationError } from "../../core/evaluation-error.js"
import { type AgentMcpServer, registeredAmlMcpServer } from "./aml-mcp-server.js"
import type { McpProps } from "./mcp.js"

/**
 * Owns one Agent's MCP scope, authenticity, duplicate, and allowlist checks.
 */
export class McpCollection {
  readonly #allowedNames: ReadonlySet<string> | undefined
  readonly #names = new Set<string>()
  readonly #servers: AgentMcpServer[] = []

  /**
   * Creates one collection for the nearest containing Agent.
   */
  constructor(allowedNames?: ReadonlySet<string>) {
    this.#allowedNames = allowedNames
  }

  /**
   * Validates and adds one MCP grant without producing prompt text.
   */
  add(props: Readonly<McpProps>): void {
    const children = Reflect.get(props, "children")
    const name = Reflect.get(props, "name")
    const use = Reflect.get(props, "use")

    if (children !== undefined) {
      throw new EvaluationError("<Mcp> does not accept children")
    }

    if ((name === undefined) === (use === undefined)) {
      throw new EvaluationError("<Mcp> requires exactly one of name or use")
    }

    const server = use === undefined ? this.#namedServer(name) : this.#configuredServer(use)
    const serverName = server.kind === "named" ? server.name : server.definition.name

    if (this.#names.has(serverName)) {
      throw new EvaluationError(`Agent declares duplicate MCP server "${serverName}"`)
    }

    if (this.#allowedNames !== undefined && !this.#allowedNames.has(serverName)) {
      throw new EvaluationError(`MCP server "${serverName}" is not allowed by this runtime`)
    }

    this.#names.add(serverName)
    this.#servers.push(server)
  }

  /**
   * Returns an immutable snapshot for the provider request.
   */
  values(): readonly AgentMcpServer[] {
    return Object.freeze([...this.#servers])
  }

  /**
   * Captures one provider-owned server name.
   */
  #namedServer(value: unknown): AgentMcpServer {
    validateName(value)
    return Object.freeze({ kind: "named", name: value })
  }

  /**
   * Recovers only an exact immutable `defineMcpServer()` identity.
   */
  #configuredServer(value: unknown): AgentMcpServer {
    const server = registeredAmlMcpServer(value)

    if (server === undefined) {
      throw new EvaluationError("<Mcp use> must be a defined MCP server")
    }

    return Object.freeze({ definition: server, kind: "configured" })
  }
}

/**
 * Enforces the shared normalized capability-name contract.
 */
function validateName(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new EvaluationError("MCP server name must be a non-empty normalized string")
  }
}
