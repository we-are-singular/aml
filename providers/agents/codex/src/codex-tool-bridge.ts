import { randomUUID } from "node:crypto"
import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
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
 * Private endpoint configuration added to one Codex invocation.
 */
interface CodexToolBridgeConnection {
  readonly headers: Readonly<Record<string, string>>
  readonly name: string
  readonly url: string
}

interface CodexMcpSession {
  readonly controller: AbortController
  closed: boolean
  readonly server: McpServer
  readonly transport: StreamableHTTPServerTransport
}

/**
 * Serves one Agent invocation's JavaScript Tools through localhost MCP.
 *
 * Codex starts a new CLI process for every FollowUp. Each process opens a new
 * MCP session, so this bridge routes any number of sessions to isolated MCP
 * Server/transport pairs while keeping the same application Tool closures.
 */
export class CodexToolBridge {
  readonly #activeRequests = new Set<Promise<void>>()
  readonly #activeToolExecutions = new Set<
    Promise<AmlJsonValue>
  >()
  readonly #authToken = randomUUID()
  readonly #context: AgentExecutionContext
  readonly #http: HttpServer
  readonly #name = `aml_${randomUUID().replaceAll("-", "")}`
  readonly #sessions = new Map<string, CodexMcpSession>()
  readonly #uninitializedSessions = new Set<CodexMcpSession>()
  readonly #tools: ReadonlyMap<string, AgentJavaScriptTool>
  #closePromise: Promise<void> | undefined
  #closing = false
  #startPromise: Promise<CodexToolBridgeConnection> | undefined

  /**
   * Captures one invocation's exact Tool set without opening a socket.
   */
  constructor(
    tools: readonly AgentJavaScriptTool[],
    context: AgentExecutionContext,
  ) {
    this.#context = context
    this.#tools = new Map(tools.map((tool) => [tool.name, tool]))
    this.#http = createServer((request, response) => {
      const handling = this.#handleRequest(request, response)
      this.#activeRequests.add(handling)

      // Node does not await request callbacks. Track their complete lifetime
      // for close(), and translate rejection into a local HTTP failure.
      void handling.then(
        () => {
          this.#activeRequests.delete(handling)
        },
        () => {
          this.#activeRequests.delete(handling)

          if (!response.headersSent) {
            response.writeHead(500).end()
          } else {
            response.destroy()
          }
        },
      )
    })
  }

  /**
   * Binds one authenticated loopback endpoint and returns its Codex config.
   */
  start(signal: AbortSignal): Promise<CodexToolBridgeConnection> {
    this.#startPromise ??= this.#start(signal)
    return this.#startPromise
  }

  /**
   * Returns one cleanup promise for every MCP session and the HTTP listener.
   */
  close(): Promise<void> {
    if (this.#closePromise === undefined) {
      // Set the gate synchronously so no request can enter between the public
      // close call and the first asynchronous cleanup step.
      this.#closing = true
      this.#closePromise = this.#close()
    }

    return this.#closePromise
  }

  /**
   * Performs the abortable listener startup once.
   */
  async #start(
    signal: AbortSignal,
  ): Promise<CodexToolBridgeConnection> {
    signal.throwIfAborted()

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
      // Abort can race the listen callback after it removes its listener.
      // Recheck before publishing a usable capability endpoint.
      signal.throwIfAborted()
    } catch (startupError) {
      try {
        await this.close()
      } catch (cleanupError) {
        throw new AggregateError(
          [startupError, cleanupError],
          "AML Codex Tool bridge startup and cleanup failed",
        )
      }

      throw startupError
    }

    const address = this.#http.address()

    if (!address || typeof address === "string") {
      const addressError = new Error(
        "AML Codex Tool bridge has no TCP address",
      )

      try {
        await this.close()
      } catch (cleanupError) {
        throw new AggregateError(
          [addressError, cleanupError],
          "AML Codex Tool bridge startup and cleanup failed",
        )
      }

      throw addressError
    }

    // The bearer token remains invocation-local and is never part of an AML
    // prompt or result. The adapter passes it only to Codex MCP configuration.
    const connection = Object.freeze({
      headers: Object.freeze({
        Authorization: `Bearer ${this.#authToken}`,
      }),
      name: this.#name,
      url: `http://127.0.0.1:${address.port}/mcp`,
    })

    return connection
  }

  /**
   * Authenticates and routes one request to its stateful MCP session.
   */
  async #handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    // The same response hides invalid paths and credentials so a local caller
    // cannot probe which part of this private endpoint it guessed correctly.
    if (
      request.url !== "/mcp" ||
      request.headers.authorization !== `Bearer ${this.#authToken}`
    ) {
      response.writeHead(404).end()
      return
    }

    if (this.#closing) {
      response.writeHead(503).end()
      return
    }

    const sessionHeader = request.headers["mcp-session-id"]

    if (
      sessionHeader !== undefined &&
      typeof sessionHeader !== "string"
    ) {
      response.writeHead(400).end()
      return
    }

    let session: CodexMcpSession

    if (sessionHeader !== undefined) {
      const existing = this.#sessions.get(sessionHeader)

      if (!existing) {
        response.writeHead(404).end()
        return
      }

      session = existing
    } else {
      // A missing session ID is valid only for initialize. The transport
      // validates the body; an unsuccessful initialization is closed below.
      if (request.method !== "POST") {
        response.writeHead(400).end()
        return
      }

      session = await this.#createSession()
      this.#uninitializedSessions.add(session)
    }

    try {
      await session.transport.handleRequest(request, response)
    } finally {
      if (session.transport.sessionId === undefined) {
        // The request did not initialize a protocol session. Do not retain a
        // server that no later request can address.
        this.#uninitializedSessions.delete(session)
        await this.#closeSession(session)
      } else if (request.method === "DELETE") {
        // DELETE closes the logical MCP session. Release its Server transport
        // immediately instead of waiting for the complete Agent invocation.
        this.#sessions.delete(session.transport.sessionId)
        await this.#closeSession(session)
      }
    }
  }

  /**
   * Creates one MCP protocol owner for a newly connecting Codex CLI process.
   */
  async #createSession(): Promise<CodexMcpSession> {
    if (this.#closing) {
      throw new Error("AML Codex Tool bridge is closing")
    }

    const controller = new AbortController()
    const server = this.#createMcpServer(controller.signal)
    let session!: CodexMcpSession
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      onsessionclosed: (sessionId) => {
        this.#sessions.delete(sessionId)
      },
      onsessioninitialized: (sessionId) => {
        this.#uninitializedSessions.delete(session)
        this.#sessions.set(sessionId, session)
      },
    })
    session = {
      controller,
      closed: false,
      server,
      transport,
    }
    // Publish the owner before connect() yields so close() cannot miss a
    // partially initialized protocol session.
    this.#uninitializedSessions.add(session)

    try {
      // MCP 1.29's concrete transport satisfies the runtime port despite an
      // exactOptionalPropertyTypes mismatch in its public declaration.
      await server.connect(transport as never)
    } catch (error) {
      await this.#closeSession(session)
      throw error
    }

    return session
  }

  /**
   * Builds an isolated MCP Server that advertises only authored AML Tools.
   */
  #createMcpServer(sessionSignal: AbortSignal): McpServer {
    const toolSummary = [...this.#tools.values()]
      .map((tool) => `${tool.name}: ${tool.description}`)
      .join("\n")
    const server = new McpServer(
      { name: this.#name, version: "0.0.0" },
      {
        capabilities: { tools: {} },
        instructions: [
          "Call the exact AML JavaScript Tool requested by the user.",
          toolSummary,
        ].join("\n"),
      },
    )

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [...this.#tools.values()].map((tool) => ({
        description: tool.description,
        inputSchema: tool.inputSchema as {
          type: "object"
          [key: string]: unknown
        },
        name: tool.name,
      })),
    }))
    server.setRequestHandler(
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

        // A Tool stops cooperatively when either its model request or the
        // complete AML evaluation is cancelled.
        const toolContext: AgentToolExecutionContext = Object.freeze({
          signal: AbortSignal.any([
            this.#context.signal,
            extra.signal,
            sessionSignal,
          ]),
          trace: this.#context.trace,
        })

        // Begin through a Promise boundary so synchronous Tool throws are also
        // registered with the provider close barrier.
        const execution = Promise.resolve().then(
          async () =>
            await tool.execute(
              request.params.arguments,
              toolContext,
            ),
        )
        this.#activeToolExecutions.add(execution)

        try {
          const result = await execution

          return {
            content: [
              {
                text: CodexToolBridge.#resultText(result),
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
        } finally {
          this.#activeToolExecutions.delete(execution)
        }
      },
    )

    return server
  }

  /**
   * Closes all protocol sessions before releasing the loopback listener.
   */
  async #close(): Promise<void> {
    const errors: unknown[] = []
    const listenerClose = this.#closeListener()

    await this.#closeKnownSessions(errors)
    await this.#drainActiveWork()

    // A request admitted before the synchronous closing gate may have been
    // connecting its session during the first snapshot. Close once more after
    // every admitted request and Tool has settled.
    await this.#closeKnownSessions(errors)
    await this.#drainActiveWork()

    try {
      await listenerClose
    } catch (error) {
      errors.push(error)
    }

    if (errors.length === 1) {
      throw errors[0]
    }

    if (errors.length > 1) {
      throw new AggregateError(
        errors,
        "AML Codex Tool bridge cleanup failed",
      )
    }
  }

  /**
   * Idempotently closes one Server/transport pair.
   */
  async #closeSession(session: CodexMcpSession): Promise<void> {
    if (session.closed) {
      return
    }

    session.closed = true
    session.controller.abort(
      new Error("AML Codex Tool bridge session closed"),
    )
    await session.server.close()
  }

  /**
   * Stops accepting connections and resolves when every HTTP socket is gone.
   */
  #closeListener(): Promise<void> {
    const closed = new Promise<void>((resolve, reject) => {
      this.#http.close((error) => {
        if (
          error &&
          (error as NodeJS.ErrnoException).code !==
            "ERR_SERVER_NOT_RUNNING"
        ) {
          reject(error)
          return
        }

        resolve()
      })
    })

    // Force-close every remaining provider socket after the synchronous gate.
    // Admitted in-process handlers and Tool cleanup remain tracked and are
    // drained separately before the Agent boundary can settle.
    this.#http.closeAllConnections()
    return closed
  }

  /**
   * Closes the complete current session set while preserving every failure.
   */
  async #closeKnownSessions(errors: unknown[]): Promise<void> {
    const sessions = new Set([
      ...this.#sessions.values(),
      ...this.#uninitializedSessions,
    ])
    this.#sessions.clear()
    this.#uninitializedSessions.clear()

    for (const session of sessions) {
      try {
        await this.#closeSession(session)
      } catch (error) {
        errors.push(error)
      }
    }
  }

  /**
   * Waits until no admitted HTTP handler or Tool cleanup remains active.
   */
  async #drainActiveWork(): Promise<void> {
    // Settling one request can schedule its Tool or final session cleanup, so
    // re-snapshot until both tracked sets are empty at the same boundary.
    while (
      this.#activeRequests.size > 0 ||
      this.#activeToolExecutions.size > 0
    ) {
      await Promise.allSettled([
        ...this.#activeRequests,
        ...this.#activeToolExecutions,
      ])
    }
  }

  /**
   * Converts snapshotted Tool output into MCP text content.
   */
  static #resultText(result: AmlJsonValue): string {
    return typeof result === "string"
      ? result
      : JSON.stringify(result)
  }
}
