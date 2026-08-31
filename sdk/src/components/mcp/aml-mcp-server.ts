const AML_MCP_SERVER_REGISTRY = Symbol.for("@aml-jsx/sdk/mcp-server-registry")

interface AmlMcpServerGlobal {
  [AML_MCP_SERVER_REGISTRY]?: WeakMap<object, AmlMcpServer>
}

/**
 * Portable local-process MCP transport owned at runtime by an Agent provider.
 */
export interface AmlMcpStdioTransport {
  /** Literal process arguments; omitted means no arguments. */
  readonly args?: readonly string[]

  /** Non-empty normalized executable name or path. */
  readonly command: string

  /**
   * Provider-environment working directory for the server process.
   *
   * Omission leaves cwd selection to the Agent provider. The provider also
   * determines whether this path belongs to the host, Sandbox, or another
   * execution environment.
   */
  readonly cwd?: string

  /**
   * String environment entries supplied to the server process.
   *
   * Omission adds no definition-specific entries. Treat values as potentially
   * secret provider configuration.
   */
  readonly env?: Readonly<Record<string, string>>

  /** Transport discriminant for a provider-owned local process. */
  readonly type: "stdio"
}

/**
 * Portable remote Streamable HTTP transport owned by an Agent provider.
 */
export interface AmlMcpStreamableHttpTransport {
  /**
   * Request headers snapshotted when the server is defined.
   *
   * Omission sends no definition-specific headers. Values may contain secrets
   * and are passed to the selected Agent provider.
   */
  readonly headers?: Readonly<Record<string, string>>

  /** Transport discriminant for a remote Streamable HTTP endpoint. */
  readonly type: "streamable-http"

  /** Normalized absolute `http:` or `https:` endpoint URL. */
  readonly url: string
}

/**
 * Complete immutable transport normalized by `defineMcpServer()`.
 */
export type AmlMcpTransport = AmlMcpStdioTransport | AmlMcpStreamableHttpTransport

/**
 * Exact immutable MCP server identity accepted by `<Mcp use>`.
 */
export interface AmlMcpServer {
  /**
   * Non-enumerable authoring marker; runtime authenticity uses exact identity.
   */
  readonly __amlMcpServer: true

  /** Non-empty normalized capability name used for grants and allowlists. */
  readonly name: string

  /** Immutable normalized transport owned at runtime by the Agent provider. */
  readonly transport: AmlMcpTransport
}

/**
 * Provider-neutral MCP capability passed to one Agent session.
 */
export type AgentMcpServer =
  | {
      /** Exact immutable server descriptor created by `defineMcpServer`. */
      readonly definition: AmlMcpServer

      /** Discriminant for an explicitly configured transport. */
      readonly kind: "configured"
    }
  | {
      /** Discriminant for a server configured natively by the Agent provider. */
      readonly kind: "named"

      /** Non-empty normalized provider-native MCP server name. */
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
export function registeredAmlMcpServer(value: unknown): AmlMcpServer | undefined {
  return typeof value === "object" && value !== null ? registry.get(value) : undefined
}

/**
 * Shares exact definition identities across physical SDK package copies.
 */
function mcpServerRegistry(): WeakMap<object, AmlMcpServer> {
  const amlGlobal = globalThis as typeof globalThis & AmlMcpServerGlobal
  const existing = amlGlobal[AML_MCP_SERVER_REGISTRY]

  if (existing !== undefined) {
    if (!(existing instanceof WeakMap)) {
      throw new TypeError("AML MCP server registry has an invalid global value")
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
