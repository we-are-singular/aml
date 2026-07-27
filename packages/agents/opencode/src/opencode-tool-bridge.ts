import { randomUUID } from "node:crypto"
import {
  createServer,
  type Server as HttpServer,
} from "node:http"

import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js"
import type {
  AgentExecutionContext,
  AgentJavaScriptTool,
  AgentToolExecutionContext,
  AmlJsonValue,
} from "@aml/sdk"

/**
 * Authenticated localhost endpoint registered with OpenCode for one invocation.
 */
export interface OpenCodeToolBridgeConnection {
  readonly headers: Readonly<Record<string, string>>
  readonly name: string
  readonly toolNames: readonly string[]
  readonly url: string
}

/**
 * Serves one Agent invocation's trusted JavaScript Tools over localhost MCP.
 */
export class OpenCodeToolBridge {
  readonly #authToken = randomUUID()
  readonly #context: AgentExecutionContext
  readonly #http: HttpServer
  readonly #mcp: McpServer
  readonly #name = `aml_${randomUUID().replaceAll("-", "")}`
  readonly #tools: ReadonlyMap<string, AgentJavaScriptTool>
  readonly #transport: StreamableHTTPServerTransport
  #closePromise: Promise<void> | undefined
  #connection: OpenCodeToolBridgeConnection | undefined

  /**
   * Creates an unstarted MCP server around one Agent's JavaScript Tools.
   */
  constructor(
    tools: readonly AgentJavaScriptTool[],
    context: AgentExecutionContext,
  ) {
    this.#context = context
    this.#tools = new Map(tools.map((tool) => [tool.name, tool]))
    this.#mcp = new McpServer(
      { name: this.#name, version: "0.0.0" },
      { capabilities: { tools: {} } },
    )
    this.#transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
    })
    this.#http = createServer((request, response) => {
      void this.#handleRequest(request, response)
    })

    // Only AML-declared Tools are advertised; the bridge has no ambient
    // capability registry or fallback to host functions.
    this.#mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: tools.map((tool) => ({
        description: tool.description,
        inputSchema: tool.inputSchema as {
          type: "object"
          [key: string]: unknown
        },
        name: tool.name,
      })),
    }))
    this.#mcp.setRequestHandler(
      CallToolRequestSchema,
      async (request, extra) => {
        const tool = this.#tools.get(request.params.name)

        if (!tool) {
          return {
            content: [
              {
                text: `Unknown AML Tool "${request.params.name}"`,
                type: "text" as const,
              },
            ],
            isError: true,
          }
        }

        // The Tool observes an aborted signal when either the complete AML
        // evaluation or OpenCode's individual MCP request is cancelled.
        // Application functions remain responsible for cooperative stopping.
        const signal = AbortSignal.any([
          this.#context.signal,
          extra.signal,
        ])
        const toolContext: AgentToolExecutionContext = Object.freeze({
          signal,
          trace: this.#context.trace,
        })

        // ToolDefinition owns input/output validation. The bridge translates
        // its attributed failure into MCP's explicit isError response.
        try {
          const result = await tool.execute(
            request.params.arguments,
            toolContext,
          )

          return {
            content: [
              {
                text: OpenCodeToolBridge.#resultText(result),
                type: "text" as const,
              },
            ],
          }
        } catch (error) {
          return {
            content: [
              {
                text:
                  error instanceof Error
                    ? error.message
                    : "AML Tool execution failed",
                type: "text" as const,
              },
            ],
            isError: true,
          }
        }
      },
    )
  }

  /**
   * Returns one shared cleanup promise for the MCP and HTTP servers.
   */
  close(): Promise<void> {
    this.#closePromise ??= this.#close()
    return this.#closePromise
  }

  /**
   * Connects MCP internals, binds an authenticated loopback endpoint, and
   * returns the configuration OpenCode must register.
   */
  async start(signal: AbortSignal): Promise<OpenCodeToolBridgeConnection> {
    if (this.#connection) {
      return this.#connection
    }

    signal.throwIfAborted()
    // MCP 1.29's transport class and interface disagree only under
    // exactOptionalPropertyTypes; the concrete transport implements the port.
    await this.#mcp.connect(this.#transport as never)

    // MCP must be connected before HTTP begins accepting provider requests.
    // Listening remains abortable because it is still capability setup.
    try {
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          this.#http.close()
          reject(signal.reason)
        }

        signal.addEventListener("abort", onAbort, { once: true })
        this.#http.once("error", reject)
        this.#http.listen(0, "127.0.0.1", () => {
          signal.removeEventListener("abort", onAbort)
          this.#http.removeListener("error", reject)
          resolve()
        })
      })
    } catch (error) {
      try {
        await this.close()
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "AML OpenCode Tool bridge startup and cleanup failed",
        )
      }

      throw error
    }

    const address = this.#http.address()

    if (!address || typeof address === "string") {
      const addressError = new Error(
        "AML OpenCode Tool bridge has no TCP address",
      )

      try {
        await this.close()
      } catch (cleanupError) {
        throw new AggregateError(
          [addressError, cleanupError],
          "AML OpenCode Tool bridge startup and cleanup failed",
        )
      }

      throw addressError
    }

    // The token is intentionally returned only to the adapter that immediately
    // registers it with OpenCode; traces must never capture these headers.
    this.#connection = Object.freeze({
      headers: Object.freeze({
        Authorization: `Bearer ${this.#authToken}`,
      }),
      name: this.#name,
      toolNames: Object.freeze([...this.#tools.keys()]),
      url: `http://127.0.0.1:${address.port}/mcp`,
    })

    return this.#connection
  }

  /**
   * Tears down protocol and transport resources while preserving all failures.
   */
  async #close(): Promise<void> {
    const errors: unknown[] = []

    try {
      await this.#mcp.close()
    } catch (error) {
      errors.push(error)
    }

    // Force idle/keep-alive sockets closed before awaiting server shutdown.
    this.#http.closeAllConnections()

    try {
      await new Promise<void>((resolve, reject) => {
        this.#http.close((error) => {
          if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") {
            reject(error)
            return
          }

          resolve()
        })
      })
    } catch (error) {
      errors.push(error)
    }

    if (errors.length === 1) {
      throw errors[0]
    }

    if (errors.length > 1) {
      throw new AggregateError(errors, "AML OpenCode Tool bridge cleanup failed")
    }
  }

  async #handleRequest(
    request: Parameters<StreamableHTTPServerTransport["handleRequest"]>[0],
    response: Parameters<StreamableHTTPServerTransport["handleRequest"]>[1],
  ): Promise<void> {
    // A 404 for both bad paths and bad credentials avoids exposing which part
    // of the private endpoint an unauthenticated caller guessed correctly.
    if (
      request.url !== "/mcp" ||
      request.headers.authorization !== `Bearer ${this.#authToken}`
    ) {
      response.writeHead(404).end()
      return
    }

    // Transport exceptions cannot escape the void Node request callback. Turn
    // them into an HTTP failure or destroy an already-started response.
    try {
      await this.#transport.handleRequest(request, response)
    } catch {
      if (!response.headersSent) {
        response.writeHead(500).end()
      } else {
        response.destroy()
      }
    }
  }

  static #resultText(result: AmlJsonValue): string {
    // MCP content is textual. Preserve authored strings exactly and serialize
    // all other already-snapshotted JSON deterministically.
    return typeof result === "string" ? result : JSON.stringify(result)
  }
}
