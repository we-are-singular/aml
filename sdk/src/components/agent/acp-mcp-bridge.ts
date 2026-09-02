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
import type { AgentStructuredOutputServices } from "./agent-structured-output-services.js"
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
  readonly #name: string
  readonly #output: AgentOutputRequest | undefined
  readonly #outputServices: Readonly<AgentStructuredOutputServices> | undefined
  readonly #tools: ReadonlyMap<string, AgentJavaScriptTool>
  #acceptStructuredOutput = false
  #closePromise: Promise<void> | undefined
  #connection: AcpMcpBridgeConnection | undefined
  #structuredAccepted = false
  #structuredCalls = 0
  #structuredError: Error | undefined
  #structuredSubmissionQueue: Promise<void> = Promise.resolve()
  #structuredValue: unknown

  readonly instruction =
    `Call ${ACP_STRUCTURED_OUTPUT_TOOL_NAME} once with the final value in its result field. ` +
    "If the Tool returns an error, correct the result and retry the call. " +
    "After the Tool accepts a result, do not call it again. " +
    "Do not return a substitute JSON value only as message text."

  constructor(
    tools: readonly AgentJavaScriptTool[],
    output: AgentOutputRequest | undefined,
    context: AgentExecutionContext,
    outputServices?: Readonly<AgentStructuredOutputServices>,
    name = "aml",
    reservedServerNames: Iterable<string> = []
  ) {
    if (tools.some(tool => tool.name === ACP_STRUCTURED_OUTPUT_TOOL_NAME)) {
      throw new TypeError(`AML JavaScript Tool name "${ACP_STRUCTURED_OUTPUT_TOOL_NAME}" is reserved`)
    }

    if ((output === undefined) !== (outputServices === undefined)) {
      throw new TypeError("AML ACP structured output requires invocation-owned validation services")
    }

    if (typeof name !== "string" || name.length === 0 || name !== name.trim()) {
      throw new TypeError("AML Tool prefix must be a non-empty normalized string")
    }

    this.#context = context
    if (new Set(reservedServerNames).has(name)) {
      throw new TypeError(`AML Tool prefix "${name}" conflicts with MCP server "${name}"`)
    }

    this.#name = name
    this.#output = output
    this.#outputServices = outputServices
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

  hasStructuredResult(): boolean {
    return this.#structuredAccepted
  }

  close(): Promise<void> {
    this.#closePromise ??= this.#close()
    return this.#closePromise
  }

  structuredResult(): unknown {
    if (this.#structuredError !== undefined) {
      throw this.#structuredError
    }

    if (!this.#structuredAccepted) {
      throw new Error(`ACP Agent did not submit a valid result through ${ACP_STRUCTURED_OUTPUT_TOOL_NAME}`)
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
    this.#http.closeAllConnections()
    await new Promise<void>((resolve, reject) => {
      this.#http.close(error => {
        if (error === undefined || (error as NodeJS.ErrnoException).code === "ERR_SERVER_NOT_RUNNING") {
          resolve()
          return
        }

        reject(error)
      })
    })
  }

  async #handleRequest(
    request: Parameters<StreamableHTTPServerTransport["handleRequest"]>[0],
    response: Parameters<StreamableHTTPServerTransport["handleRequest"]>[1]
  ): Promise<void> {
    if (request.url !== "/mcp" || request.headers.authorization !== `Bearer ${this.#authToken}`) {
      response.writeHead(404).end()
      return
    }

    if (request.method !== "POST") {
      response.writeHead(405, { Allow: "POST" }).end()
      return
    }

    const server = this.#createMcpServer()
    const transport = new StreamableHTTPServerTransport({
      enableJsonResponse: true,
    })

    try {
      // The SDK documents omitted sessionIdGenerator as stateless mode. Its
      // duplicated Transport declarations disagree under exact optional types.
      await server.connect(transport as never)
      await transport.handleRequest(request, response)
    } catch {
      if (!response.headersSent) {
        response.writeHead(500).end()
      } else {
        response.destroy()
      }
    } finally {
      await server.close().catch(() => undefined)
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
    const call = this.#structuredCalls

    const submission = this.#structuredSubmissionQueue.then(
      async () => await this.#processStructuredOutput(argumentsValue, call)
    )
    this.#structuredSubmissionQueue = submission.then(
      () => undefined,
      () => undefined
    )
    return submission
  }

  async #processStructuredOutput(argumentsValue: unknown, call: number) {
    if (this.#output === undefined) {
      this.#structuredError ??= new Error("ACP Agent submitted structured output for a text invocation")
      return toolError(this.#structuredError.message)
    }

    if (!this.#acceptStructuredOutput) {
      const message = "ACP Agent submitted structured output before the final authored turn"
      this.#outputServices?.traceSubmission(call, "invalid", argumentsValue)
      return toolError(message)
    }

    if (this.#structuredAccepted) {
      this.#outputServices?.traceSubmission(call, "ignored", argumentsValue)
      return {
        content: [
          {
            text: "A valid structured result was already accepted; this submission was ignored.",
            type: "text" as const,
          },
        ],
      }
    }

    if (
      typeof argumentsValue !== "object" ||
      argumentsValue === null ||
      !Object.prototype.hasOwnProperty.call(argumentsValue, "result")
    ) {
      const message = `${ACP_STRUCTURED_OUTPUT_TOOL_NAME} requires a result property`
      this.#outputServices?.traceSubmission(call, "invalid", argumentsValue)
      return toolError(message)
    }

    const result = Reflect.get(argumentsValue, "result")

    try {
      await this.#outputServices?.validate(result)
    } catch (error) {
      this.#outputServices?.traceSubmission(call, "invalid", result)
      return toolError(validationErrorMessage(error))
    }

    this.#structuredAccepted = true
    this.#structuredValue = result
    this.#outputServices?.traceSubmission(call, "accepted", result)
    return {
      content: [{ text: "Structured result accepted.", type: "text" as const }],
    }
  }
}

function validationErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return "Structured result failed schema validation"

  const cause = error.cause
  if (cause === undefined) return error.message

  try {
    return `${error.message}: ${JSON.stringify(cause)}`
  } catch {
    return error.message
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
