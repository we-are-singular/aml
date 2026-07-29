import {
  createAgentProviderTurns,
  executeAgentProviderSession,
  type AgentExecutionContext,
  type AgentProviderSession,
  type AgentProviderTurn,
  type AgentRequest,
  type AgentResponse,
} from "@aml-jsx/sdk"
import { defu } from "defu"

import type {
  OpenCodeModel,
  OpenCodeSessionClient,
  OpenCodeSessionLocation,
  OpenCodeSessionPromptResult,
} from "./opencode-session-client.js"

interface OpenCodeSessionOptions {
  readonly directory?: string
  readonly model?: string
}

/**
 * Owns one fresh OpenCode session and its failure-safe cleanup.
 */
export class OpenCodeSession {
  readonly #client: OpenCodeSessionClient
  readonly #directory: string | undefined
  readonly #model: string | undefined

  /**
   * Captures the provider port and configured per-provider defaults.
   */
  constructor(client: OpenCodeSessionClient, options: OpenCodeSessionOptions) {
    this.#client = client
    this.#directory = options.directory
    this.#model = options.model
  }

  /**
   * Parses OpenCode's provider/model string without interpreting either part.
   */
  static parseModel(value: string | undefined): OpenCodeModel | undefined {
    if (value === undefined) {
      return undefined
    }

    if (typeof value !== "string") {
      throw new TypeError("OpenCode model must be a string")
    }

    if (value !== value.trim()) {
      throw new TypeError("OpenCode model must already be normalized as provider/model")
    }

    const separator = value.indexOf("/")

    if (separator <= 0 || separator === value.length - 1) {
      throw new TypeError("OpenCode model must use provider/model")
    }

    return Object.freeze({
      modelId: value.slice(separator + 1),
      providerId: value.slice(0, separator),
    })
  }

  /**
   * Executes one fresh OpenCode session with failure-safe capability cleanup.
   */
  async run(request: AgentRequest, context: AgentExecutionContext): Promise<AgentResponse> {
    context.signal.throwIfAborted()
    const turns = createAgentProviderTurns(request, "opencode")
    const session = await this.open(request, context)
    return await executeAgentProviderSession(session, turns, context, "opencode")
  }

  /**
   * Attaches capabilities and creates one fresh OpenCode conversation.
   */
  async open(request: AgentRequest, context: AgentExecutionContext): Promise<AgentProviderSession> {
    const defaults = {
      ...(this.#directory === undefined ? {} : { directory: this.#directory }),
      ...(this.#model === undefined ? {} : { model: this.#model }),
    }
    const userInputs = request.model === undefined ? {} : { model: request.model }
    const resolved = defu(userInputs, defaults) as OpenCodeSessionOptions
    const directory = resolved.directory
    const model = OpenCodeSession.parseModel(resolved.model)

    // Capability incompatibility and attachment failure must happen before any
    // remote session exists. This is both a side-effect and security boundary.
    const capabilityAttachment = await this.#client.attachCapabilities(
      defu(
        {
          context,
          mcpServers: request.mcpServers,
          structuredOutput: request.output !== undefined,
          tools: request.tools,
        },
        directory === undefined ? {} : { directory }
      ),
      context.signal
    )
    let closeCapabilityAttachment: (() => Promise<void>) | undefined
    let capabilityTools: Readonly<Record<string, boolean>>

    // Attachment can already own live MCP and Tool resources. Capture its
    // cleanup capability before reading any other provider-owned accessor so a
    // malformed Tool map can still be compensated without leaking resources.
    try {
      if (typeof capabilityAttachment !== "object" || capabilityAttachment === null) {
        throw new TypeError("OpenCode session client returned an invalid capability attachment")
      }

      const close = capabilityAttachment.close

      if (typeof close !== "function") {
        throw new TypeError("OpenCode capability attachment close must be a function")
      }

      closeCapabilityAttachment = async () => {
        await Reflect.apply(close, capabilityAttachment, [])
      }

      const tools = capabilityAttachment.tools

      if (typeof tools !== "object" || tools === null || Array.isArray(tools)) {
        throw new TypeError("OpenCode capability attachment tools must be an object")
      }

      const entries = Object.entries(tools)

      if (entries.some(([, enabled]) => typeof enabled !== "boolean")) {
        throw new TypeError("OpenCode capability attachment tools must contain booleans")
      }

      capabilityTools = Object.freeze(Object.fromEntries(entries))

      // Every prompt must fail closed against OpenCode's ambient capability
      // registry before exact authored grants are added.
      if (capabilityTools["*"] !== false) {
        throw new TypeError('OpenCode capability attachment must disable the "*" Tool wildcard')
      }

      if (request.output !== undefined && capabilityTools.StructuredOutput !== true) {
        throw new TypeError("OpenCode structured requests require the StructuredOutput Tool grant")
      }

      if (request.output === undefined && capabilityTools.StructuredOutput === true) {
        throw new TypeError("OpenCode text requests cannot grant the StructuredOutput Tool")
      }
    } catch (attachmentError) {
      if (closeCapabilityAttachment === undefined) {
        throw attachmentError
      }

      try {
        await closeCapabilityAttachment()
      } catch (cleanupError) {
        throw new AggregateError([attachmentError, cleanupError], "OpenCode capability validation and cleanup failed")
      }

      throw attachmentError
    }

    const textTurnTools =
      request.output === undefined
        ? capabilityTools
        : Object.freeze(
            Object.fromEntries(Object.entries(capabilityTools).filter(([name]) => name !== "StructuredOutput"))
          )
    let sessionId: string

    // A created attachment is already a live resource, so session-creation
    // failure must close it and preserve both errors when cleanup also fails.
    try {
      context.signal.throwIfAborted()
      sessionId = await this.#client.create(
        defu(
          {
            title: `AML ${context.trace.spanId}`,
          },
          {
            ...(directory === undefined ? {} : { directory }),
            ...(model === undefined ? {} : { model }),
          }
        ),
        context.signal
      )

      if (typeof sessionId !== "string" || sessionId.length === 0) {
        throw new TypeError("OpenCode session client must return a non-empty session ID")
      }
    } catch (creationError) {
      const errors: unknown[] = [creationError]

      try {
        await closeCapabilityAttachment()
      } catch (cleanupError) {
        errors.push(cleanupError)
      }

      if (errors.length > 1) {
        throw new AggregateError(errors, "OpenCode session creation and capability cleanup failed")
      }

      throw creationError
    }

    const location: OpenCodeSessionLocation = Object.freeze({
      ...(directory === undefined ? {} : { directory }),
      sessionId,
    })
    return new ActiveOpenCodeSession({
      capabilityTools,
      client: this.#client,
      closeCapabilityAttachment,
      location,
      model,
      system: request.system,
      textTurnTools,
    })
  }

  /**
   * Selects only validated, user-visible text from OpenCode response parts.
   */
  static visibleText(result: OpenCodeSessionPromptResult): string {
    const error = result.error

    if (error !== undefined) {
      throw new Error("OpenCode returned an assistant error", {
        cause: error,
      })
    }

    const parts = result.parts

    if (!Array.isArray(parts)) {
      throw new TypeError("OpenCode returned an invalid parts collection")
    }

    const chunks: string[] = []

    for (const part of parts) {
      if (typeof part !== "object" || part === null) {
        throw new TypeError("OpenCode returned an invalid response part")
      }

      const type = part.type
      const synthetic = part.synthetic
      const ignored = part.ignored

      // Tool, reasoning, synthetic, and ignored content stays in provider
      // traces/history and never becomes AML's string result.
      if (
        typeof type !== "string" ||
        (synthetic !== undefined && typeof synthetic !== "boolean") ||
        (ignored !== undefined && typeof ignored !== "boolean")
      ) {
        throw new TypeError("OpenCode returned invalid response metadata")
      }

      if (type !== "text" || synthetic === true || ignored === true) {
        continue
      }

      // Provider values can expose getters, so capture validated data once.
      const text = part.text

      if (typeof text !== "string") {
        throw new TypeError("OpenCode returned an invalid visible text part")
      }

      chunks.push(text)
    }

    return chunks.join("")
  }
}

interface ActiveOpenCodeSessionOptions {
  readonly capabilityTools: Readonly<Record<string, boolean>>
  readonly client: OpenCodeSessionClient
  readonly closeCapabilityAttachment: () => Promise<void>
  readonly location: OpenCodeSessionLocation
  readonly model: OpenCodeModel | undefined
  readonly system: string
  readonly textTurnTools: Readonly<Record<string, boolean>>
}

/**
 * Owns one acknowledged OpenCode session and its capability attachment.
 */
class ActiveOpenCodeSession implements AgentProviderSession {
  readonly #capabilityTools: Readonly<Record<string, boolean>>
  readonly #client: OpenCodeSessionClient
  readonly #closeCapabilityAttachment: () => Promise<void>
  readonly #location: OpenCodeSessionLocation
  readonly #model: OpenCodeModel | undefined
  readonly #system: string
  readonly #textTurnTools: Readonly<Record<string, boolean>>

  constructor(options: ActiveOpenCodeSessionOptions) {
    this.#capabilityTools = options.capabilityTools
    this.#client = options.client
    this.#closeCapabilityAttachment = options.closeCapabilityAttachment
    this.#location = options.location
    this.#model = options.model
    this.#system = options.system
    this.#textTurnTools = options.textTurnTools
  }

  async abort(): Promise<void> {
    await this.#client.abort(this.#location)
  }

  async runTurn(turn: Readonly<AgentProviderTurn>, context: AgentExecutionContext): Promise<AgentResponse> {
    const result = await this.#client.prompt(
      defu(
        {
          // Intermediate turns remain ordinary text. The schema constrains
          // only the final response that escapes the Agent boundary.
          ...(turn.output === undefined ? {} : { output: turn.output }),
          prompt: turn.prompt,
          system: this.#system,
          // Capability attachment is session-wide, but OpenCode's internal
          // StructuredOutput Tool is granted only with the final schema turn.
          tools: turn.output === undefined ? this.#textTurnTools : this.#capabilityTools,
        },
        {
          ...this.#location,
          ...(this.#model === undefined ? {} : { model: this.#model }),
        }
      ),
      context.signal
    )

    context.signal.throwIfAborted()
    const text = OpenCodeSession.visibleText(result)

    return Object.freeze({
      ...(Reflect.has(result, "structured") ? { structured: result.structured } : {}),
      text,
    })
  }

  async close(): Promise<void> {
    const errors: unknown[] = []

    try {
      await this.#closeCapabilityAttachment()
    } catch (error) {
      errors.push(error)
    }

    try {
      await this.#client.delete(this.#location)
    } catch (error) {
      errors.push(error)
    }

    if (errors.length === 1) {
      throw errors[0]
    }

    if (errors.length > 1) {
      throw new AggregateError(errors, `OpenCode session ${this.#location.sessionId} failed during cleanup`)
    }
  }
}
