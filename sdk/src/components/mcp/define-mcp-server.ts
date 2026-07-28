import {
  type AmlMcpServer,
  type AmlMcpStdioTransport,
  type AmlMcpStreamableHttpTransport,
  registerAmlMcpServer,
} from "./aml-mcp-server.js"

/**
 * Local-process transport accepted by `defineMcpServer()`.
 */
export interface DefineMcpStdioTransport {
  readonly args?: readonly string[]
  readonly command: string
  readonly cwd?: string
  readonly env?: Readonly<Record<string, string>>
  readonly type: "stdio"
}

/**
 * Streamable HTTP input accepts URL objects before normalizing to text.
 */
export interface DefineMcpStreamableHttpTransport {
  readonly headers?: Readonly<Record<string, string>>
  readonly type: "streamable-http"
  readonly url: string | URL
}

/**
 * Complete side-effect-free MCP definition input.
 */
export interface DefineMcpServerOptions {
  readonly name: string
  readonly transport: DefineMcpStdioTransport | DefineMcpStreamableHttpTransport
}

/**
 * Defines one immutable portable MCP server without connecting to it.
 */
export function defineMcpServer(options: DefineMcpServerOptions): Readonly<AmlMcpServer> {
  if (typeof options !== "object" || options === null) {
    throw new TypeError("MCP server definition must be an object")
  }

  let name: unknown
  let transport: unknown

  try {
    // External configuration may contain stateful getters. Capture each
    // authority-bearing field once before validating or snapshotting it.
    name = options.name
    transport = options.transport
  } catch (cause) {
    throw new TypeError("MCP server definition must be readable", {
      cause,
    })
  }

  validateNormalizedText(name, "MCP server name")
  const server = {
    name,
    transport: normalizeTransport(transport),
  } as AmlMcpServer

  // The marker makes accidental structural definitions fail TypeScript while
  // the registry remains the actual cross-copy authenticity boundary.
  Object.defineProperty(server, "__amlMcpServer", {
    enumerable: false,
    value: true,
  })
  Object.freeze(server)

  registerAmlMcpServer(server)
  return server
}

/**
 * Selects and snapshots one supported standard transport.
 */
function normalizeTransport(value: unknown): AmlMcpStdioTransport | AmlMcpStreamableHttpTransport {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("MCP server transport must be an object")
  }

  let type: unknown

  try {
    type = Reflect.get(value, "type")
  } catch (cause) {
    throw new TypeError("MCP server transport must be readable", {
      cause,
    })
  }

  if (type === "stdio") {
    return normalizeStdioTransport(value)
  }

  if (type === "streamable-http") {
    return normalizeHttpTransport(value)
  }

  throw new TypeError('MCP server transport type must be "stdio" or "streamable-http"')
}

/**
 * Validates process settings while retaining arguments exactly as authored.
 */
function normalizeStdioTransport(value: object): AmlMcpStdioTransport {
  let args: unknown
  let command: unknown
  let cwd: unknown
  let env: unknown

  try {
    args = Reflect.get(value, "args")
    command = Reflect.get(value, "command")
    cwd = Reflect.get(value, "cwd")
    env = Reflect.get(value, "env")
  } catch (cause) {
    throw new TypeError("MCP stdio transport must be readable", {
      cause,
    })
  }

  validateNormalizedText(command, "MCP stdio command")

  if (cwd !== undefined) {
    validateNormalizedText(cwd, "MCP stdio cwd")
  }

  const normalizedArgs = args === undefined ? undefined : captureStringArray(args, "MCP stdio args")
  const normalizedEnv = env === undefined ? undefined : captureStringRecord(env, "MCP stdio env")

  return Object.freeze({
    ...(normalizedArgs === undefined ? {} : { args: normalizedArgs }),
    command,
    ...(cwd === undefined ? {} : { cwd }),
    ...(normalizedEnv === undefined ? {} : { env: normalizedEnv }),
    type: "stdio" as const,
  })
}

/**
 * Normalizes a remote endpoint and snapshots credential-bearing headers.
 */
function normalizeHttpTransport(value: object): AmlMcpStreamableHttpTransport {
  let headers: unknown
  let rawUrl: unknown

  try {
    headers = Reflect.get(value, "headers")
    rawUrl = Reflect.get(value, "url")
  } catch (cause) {
    throw new TypeError("MCP Streamable HTTP transport must be readable", { cause })
  }

  if (!(typeof rawUrl === "string" || rawUrl instanceof URL)) {
    throw new TypeError("MCP Streamable HTTP url must be a string or URL")
  }

  let url: URL

  try {
    url = new URL(rawUrl)
  } catch (cause) {
    throw new TypeError("MCP Streamable HTTP url must be an absolute URL", { cause })
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("MCP Streamable HTTP url must use http or https")
  }

  const normalizedHeaders =
    headers === undefined ? undefined : captureStringRecord(headers, "MCP Streamable HTTP headers")

  return Object.freeze({
    ...(normalizedHeaders === undefined ? {} : { headers: normalizedHeaders }),
    type: "streamable-http" as const,
    url: url.href,
  })
}

/**
 * Copies one readonly argument array and rejects non-string entries.
 */
function captureStringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${label} must be an array of strings`)
  }

  // Snapshot before validation so stateful index getters cannot swap a checked
  // string for a different process argument during a second traversal.
  const snapshot = [...value] as unknown[]

  if (snapshot.some(entry => typeof entry !== "string")) {
    throw new TypeError(`${label} must be an array of strings`)
  }

  return Object.freeze(snapshot) as readonly string[]
}

/**
 * Copies one plain enumerable string record without retaining accessors.
 */
function captureStringRecord(value: unknown, label: string): Readonly<Record<string, string>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object of strings`)
  }

  let entries: [string, unknown][]

  try {
    entries = Object.entries(value)
  } catch (cause) {
    throw new TypeError(`${label} must be readable`, { cause })
  }

  if (entries.some(([, entry]) => typeof entry !== "string")) {
    throw new TypeError(`${label} must be an object of strings`)
  }

  return Object.freeze(Object.fromEntries(entries)) as Readonly<Record<string, string>>
}

/**
 * Enforces stable identity text without silently rewriting it.
 */
function validateNormalizedText(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new TypeError(`${label} must be a non-empty normalized string`)
  }
}
