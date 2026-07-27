const AML_MCP_SERVER_REGISTRY = Symbol.for(
  "@aml/sdk/mcp-server-registry",
)

interface AmlMcpServerGlobal {
  [AML_MCP_SERVER_REGISTRY]?: WeakMap<object, AmlMcpServer>
}

/**
 * Portable local-process MCP transport owned at runtime by an Agent provider.
 */
export interface AmlMcpStdioTransport {
  readonly args?: readonly string[]
  readonly command: string
  readonly cwd?: string
  readonly env?: Readonly<Record<string, string>>
  readonly type: "stdio"
}

/**
 * Portable remote Streamable HTTP transport owned by an Agent provider.
 */
export interface AmlMcpStreamableHttpTransport {
  readonly headers?: Readonly<Record<string, string>>
  readonly type: "streamable-http"
  readonly url: string
}

/**
 * Complete immutable transport normalized by `defineMcpServer()`.
 */
export type AmlMcpTransport =
  | AmlMcpStdioTransport
  | AmlMcpStreamableHttpTransport

/**
 * Exact immutable MCP server identity accepted by `<Mcp use>`.
 */
export interface AmlMcpServer {
  /**
   * Non-enumerable authoring marker; runtime authenticity uses exact identity.
   */
  readonly __amlMcpServer: true
  readonly name: string
  readonly transport: AmlMcpTransport
}

/**
 * Provider-neutral MCP capability passed to one Agent session.
 */
export type AgentMcpServer =
  | {
      readonly definition: AmlMcpServer
      readonly kind: "configured"
    }
  | {
      readonly kind: "named"
      readonly name: string
    }

const registry = mcpServerRegistry()

/**
 * Registers one trusted definition for exact cross-copy identity recovery.
 */
export function registerAmlMcpServer(server: AmlMcpServer): void {
  registry.set(server, server)
}

/**
 * Recovers only an exact identity previously created by `defineMcpServer()`.
 */
export function registeredAmlMcpServer(
  value: unknown,
): AmlMcpServer | undefined {
  return typeof value === "object" && value !== null
    ? registry.get(value)
    : undefined
}

/**
 * Shares exact definition identities across physical SDK package copies.
 */
function mcpServerRegistry(): WeakMap<object, AmlMcpServer> {
  const amlGlobal = globalThis as typeof globalThis & AmlMcpServerGlobal
  const existing = amlGlobal[AML_MCP_SERVER_REGISTRY]

  if (existing !== undefined) {
    if (!(existing instanceof WeakMap)) {
      throw new TypeError(
        "AML MCP server registry has an invalid global value",
      )
    }

    return existing
  }

  const created = new WeakMap<object, AmlMcpServer>()

  Object.defineProperty(amlGlobal, AML_MCP_SERVER_REGISTRY, {
    configurable: false,
    enumerable: false,
    value: created,
    writable: false,
  })

  return created
}
