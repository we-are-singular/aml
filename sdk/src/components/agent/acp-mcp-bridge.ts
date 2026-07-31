import { randomUUID } from "node:crypto"
import { createServer, type Server as HttpServer } from "node:http"

import type { McpServer as AcpMcpServer } from "@agentclientprotocol/sdk"
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"

import type { AmlJsonValue } from "../../core/aml-json-value.js"
import type { AgentJavaScriptTool, AgentToolExecutionContext } from "../tool/agent-tool.js"
import type { AgentExecutionContext } from "./agent-execution-context.js"
import type { AgentOutputRequest } from "./agent-output-request.js"
import type { AcpStructuredOutputController } from "./acp-agent-session.js"

export const ACP_STRUCTURED_OUTPUT_TOOL_NAME = "aml_submit_result"

/**
 * Authenticated loopback MCP endpoint for one ACP Agent invocation.
 */
export interface AcpMcpBridgeConnection {
  readonly headers: Readonly<Record<string, string>>
  readonly name: string
  readonly url: string
}

/**
 * Serves AML JavaScript Tools and structured submission through one MCP server.
 */
export class AcpMcpBridge implements AcpStructuredOutputController {
  readonly #authToken = randomUUID()
  readonly #context: AgentExecutionContext
  readonly #http: HttpServer
  readonly #name = `aml_${randomUUID().replaceAll("-", "")}`
  readonly #output: AgentOutputRequest | undefined
  readonly #sessions = new Map<string, Readonly<{ server: McpServer; transport: StreamableHTTPServerTransport }>>()
  readonly #tools: ReadonlyMap<string, AgentJavaScriptTool>
  #acceptStructuredOutput = false
  #closePromise: Promise<void> | undefined
  #connection: AcpMcpBridgeConnection | undefined
  #structuredCalls = 0
  #structuredError: Error | undefined
  #structuredValue: unknown

  readonly instruction =
    `Call ${ACP_STRUCTURED_OUTPUT_TOOL_NAME} exactly once with the final value in its result field. ` +
    "Do not return a substitute JSON value only as message text."

  constructor(
    tools: readonly AgentJavaScriptTool[],
    output: AgentOutputRequest | undefined,
    context: AgentExecutionContext
  ) {
    if (tools.some(tool => tool.name === ACP_STRUCTURED_OUTPUT_TOOL_NAME)) {
      throw new TypeError(`AML JavaScript Tool name "${ACP_STRUCTURED_OUTPUT_TOOL_NAME}" is reserved`)
    }

    this.#context = context
    this.#output = output
    this.#tools = new Map(tools.map(tool => [tool.name, tool]))
    this.#http = createServer((request, response) => {
      void this.#handleRequest(request, response)
    })
  }

  /**
   * Returns the HTTP descriptor passed to ACP session creation or a relay.
   */
  asMcpServer(connection = this.#requiredConnection()): AcpMcpServer {
    return {
      headers: Object.entries(connection.headers).map(([name, value]) => ({ name, value })),
      name: connection.name,
      type: "http",
      url: connection.url,
    }
  }

  beginStructuredTurn(): void {
    this.#acceptStructuredOutput = true
  }

  close(): Promise<void> {
    this.#closePromise ??= this.#close()
    return this.#closePromise
  }

  structuredResult(): unknown {
    if (this.#structuredError !== undefined) {
      throw this.#structuredError
    }

    if (this.#structuredCalls !== 1) {
      throw new Error(`ACP Agent must call ${ACP_STRUCTURED_OUTPUT_TOOL_NAME} exactly once on the structured turn`)
    }

    return this.#structuredValue
  }

  /**
   * Binds the private host endpoint after all request handlers are ready.
   */
  async start(signal: AbortSignal): Promise<Readonly<AcpMcpBridgeConnection>> {
    if (this.#connection !== undefined) {
      return this.#connection
    }

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
    } catch (error) {
      try {
        await this.close()
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "AML ACP MCP bridge startup and cleanup failed")
      }

      throw error
    }

    const address = this.#http.address()

    if (address === null || typeof address === "string") {
      const addressError = new Error("AML ACP MCP bridge has no TCP address")

      try {
        await this.close()
      } catch (cleanupError) {
        throw new AggregateError([addressError, cleanupError], "AML ACP MCP bridge startup and cleanup failed")
      }

      throw addressError
    }

    this.#connection = Object.freeze({
      headers: Object.freeze({
        Authorization: `Bearer ${this.#authToken}`,
      }),
      name: this.#name,
      url: `http://127.0.0.1:${address.port}/mcp`,
    })
    return this.#connection
  }

  async #close(): Promise<void> {
    const errors: unknown[] = []

    for (const session of [...this.#sessions.values()]) {
      try {
        await session.server.close()
      } catch (error) {
        errors.push(error)
      }
    }
    this.#sessions.clear()

    this.#http.closeAllConnections()

    try {
      await new Promise<void>((resolve, reject) => {
        this.#http.close(error => {
          if (error !== undefined && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") {
            reject(error)
            return
          }

          resolve()
        })
      })
    } catch (error) {
      errors.push(error)
    }

    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) throw new AggregateError(errors, "AML ACP MCP bridge cleanup failed")
  }

  async #handleRequest(
    request: Parameters<StreamableHTTPServerTransport["handleRequest"]>[0],
    response: Parameters<StreamableHTTPServerTransport["handleRequest"]>[1]
  ): Promise<void> {
    if (request.url !== "/mcp" || request.headers.authorization !== `Bearer ${this.#authToken}`) {
      response.writeHead(404).end()
      return
    }

    const rawSessionId = request.headers["mcp-session-id"]
    const sessionId = Array.isArray(rawSessionId) ? undefined : rawSessionId

    try {
      if (sessionId !== undefined) {
        const session = this.#sessions.get(sessionId)
        if (session === undefined) {
          response.writeHead(400).end("Invalid MCP session")
          return
        }

        await session.transport.handleRequest(request, response)
        return
      }

      if (request.method !== "POST") {
        response.writeHead(400).end("Missing MCP session")
        return
      }

      const server = this.#createMcpServer()
      const transport = new StreamableHTTPServerTransport({
        onsessioninitialized: (initializedSessionId: string) => {
          this.#sessions.set(initializedSessionId, { server, transport })
        },
        sessionIdGenerator: randomUUID,
      } as never)
      transport.onclose = () => {
        if (transport.sessionId !== undefined) {
          this.#sessions.delete(transport.sessionId)
        }
      }
      await server.connect(transport as never)
      await transport.handleRequest(request, response)

      if (transport.sessionId === undefined) {
        await server.close()
      }
    } catch {
      if (!response.headersSent) {
        response.writeHead(500).end()
      } else {
        response.destroy()
      }
    }
  }

  #createMcpServer(): McpServer {
    const server = new McpServer({ name: this.#name, version: "0.0.0" }, { capabilities: { tools: {} } })
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        ...[...this.#tools.values()].map(tool => ({
          description: tool.description,
          inputSchema: tool.inputSchema as {
            type: "object"
            [key: string]: unknown
          },
          name: tool.name,
        })),
        ...(this.#output === undefined
          ? []
          : [
              {
                description: "Submit the final structured result for this AML invocation.",
                inputSchema: {
                  additionalProperties: false,
                  properties: {
                    result: this.#output.jsonSchema,
                  },
                  required: ["result"],
                  type: "object" as const,
                },
                name: ACP_STRUCTURED_OUTPUT_TOOL_NAME,
              },
            ]),
      ],
    }))
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      if (request.params.name === ACP_STRUCTURED_OUTPUT_TOOL_NAME) {
        return this.#submitStructuredOutput(request.params.arguments)
      }

      const tool = this.#tools.get(request.params.name)

      if (tool === undefined) {
        return toolError(`Unknown AML Tool "${request.params.name}"`)
      }

      const signal = AbortSignal.any([this.#context.signal, extra.signal])
      const toolContext: AgentToolExecutionContext = Object.freeze({
        signal,
        trace: this.#context.trace,
      })

      try {
        const result = await tool.execute(request.params.arguments, toolContext)
        return {
          content: [
            {
              text: resultText(result),
              type: "text" as const,
            },
          ],
        }
      } catch (error) {
        return toolError(error instanceof Error ? error.message : "AML Tool execution failed")
      }
    })
    return server
  }

  #requiredConnection(): Readonly<AcpMcpBridgeConnection> {
    if (this.#connection === undefined) {
      throw new Error("AML ACP MCP bridge must be started before use")
    }

    return this.#connection
  }

  #submitStructuredOutput(argumentsValue: unknown) {
    this.#structuredCalls += 1

    if (this.#output === undefined) {
      this.#structuredError ??= new Error("ACP Agent submitted structured output for a text invocation")
      return toolError(this.#structuredError.message)
    }

    if (!this.#acceptStructuredOutput) {
      this.#structuredError ??= new Error("ACP Agent submitted structured output before the final authored turn")
      return toolError(this.#structuredError.message)
    }

    if (this.#structuredCalls > 1) {
      this.#structuredError ??= new Error("ACP Agent submitted structured output more than once")
      return toolError(this.#structuredError.message)
    }

    if (
      typeof argumentsValue !== "object" ||
      argumentsValue === null ||
      !Object.prototype.hasOwnProperty.call(argumentsValue, "result")
    ) {
      this.#structuredError ??= new Error(`${ACP_STRUCTURED_OUTPUT_TOOL_NAME} requires a result property`)
      return toolError(this.#structuredError.message)
    }

    this.#structuredValue = Reflect.get(argumentsValue, "result")
    return {
      content: [{ text: "Structured result accepted.", type: "text" as const }],
    }
  }
}

function resultText(result: AmlJsonValue): string {
  return typeof result === "string" ? result : JSON.stringify(result)
}

function toolError(message: string) {
  return {
    content: [{ text: message, type: "text" as const }],
    isError: true,
  }
}
