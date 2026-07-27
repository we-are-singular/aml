import type {
  AgentExecutionContext,
  AgentRequest,
  AgentResponse,
} from "@aml/sdk"

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
  constructor(
    client: OpenCodeSessionClient,
    options: OpenCodeSessionOptions,
  ) {
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
      throw new TypeError(
        "OpenCode model must already be normalized as provider/model",
      )
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
  async run(
    request: AgentRequest,
    context: AgentExecutionContext,
  ): Promise<AgentResponse> {
    context.signal.throwIfAborted()

    const model = OpenCodeSession.parseModel(request.model ?? this.#model)
    // Capability incompatibility and attachment failure must happen before any
    // remote session exists. This is both a side-effect and security boundary.
    const capabilityAttachment = await this.#client.attachCapabilities(
      {
        ...(this.#directory === undefined
          ? {}
          : { directory: this.#directory }),
        context,
        mcpServers: request.mcpServers,
        structuredOutput: request.output !== undefined,
        tools: request.tools,
      },
      context.signal,
    )
    let sessionId: string

    // A created attachment is already a live resource, so session-creation
    // failure must close it and preserve both errors when cleanup also fails.
    try {
      context.signal.throwIfAborted()
      sessionId = await this.#client.create(
        {
          ...(this.#directory === undefined
            ? {}
            : { directory: this.#directory }),
          ...(model === undefined ? {} : { model }),
          title: `AML ${context.trace.spanId}`,
        },
        context.signal,
      )

      if (typeof sessionId !== "string" || sessionId.length === 0) {
        throw new TypeError(
          "OpenCode session client must return a non-empty session ID",
        )
      }
    } catch (creationError) {
      const errors: unknown[] = [creationError]

      try {
        await capabilityAttachment.close()
      } catch (cleanupError) {
        errors.push(cleanupError)
      }

      if (errors.length > 1) {
        throw new AggregateError(
          errors,
          "OpenCode session creation and capability cleanup failed",
        )
      }

      throw creationError
    }

    const location: OpenCodeSessionLocation = Object.freeze({
      ...(this.#directory === undefined
        ? {}
        : { directory: this.#directory }),
      sessionId,
    })
    let hasAbortError = false
    let abortError: unknown
    let abortPromise: Promise<void> | undefined

    const requestAbort = () => {
      // Multiple abort observations share one provider request and one captured
      // result; cancellation must not race duplicate session aborts.
      abortPromise ??= this.#client.abort(location).then(
        () => undefined,
        (error: unknown) => {
          hasAbortError = true
          abortError = error
        },
      )
    }

    if (context.signal.aborted) {
      requestAbort()
    } else {
      context.signal.addEventListener("abort", requestAbort, { once: true })
    }

    let hasExecutionError = false
    let executionError: unknown
    let response: AgentResponse | undefined

    // Prompt execution is separate from cleanup so every failure path still
    // closes capability resources and deletes the acknowledged session.
    try {
      const result = await this.#client.prompt(
        {
          ...location,
          ...(model === undefined ? {} : { model }),
          ...(request.output === undefined
            ? {}
            : { output: request.output }),
          prompt: request.prompt,
          system: request.system,
          tools: capabilityAttachment.tools,
        },
        context.signal,
      )

      context.signal.throwIfAborted()
      response = Object.freeze({
        ...(Reflect.has(result, "structured")
          ? { structured: result.structured }
          : {}),
        text: OpenCodeSession.visibleText(result),
      })
    } catch (error) {
      hasExecutionError = true
      executionError = error
    } finally {
      context.signal.removeEventListener("abort", requestAbort)
    }

    await abortPromise

    let hasCapabilityCleanupError = false
    let capabilityCleanupError: unknown

    try {
      await capabilityAttachment.close()
    } catch (error) {
      hasCapabilityCleanupError = true
      capabilityCleanupError = error
    }

    let hasCleanupError = false
    let cleanupError: unknown

    try {
      await this.#client.delete(location)
    } catch (error) {
      hasCleanupError = true
      cleanupError = error
    }

    // Cleanup failures are causally significant. Preserve them in deterministic
    // lifecycle order instead of masking execution or cancellation failures.
    const errors: unknown[] = []

    if (hasExecutionError) {
      errors.push(executionError)
    }

    if (hasAbortError) {
      errors.push(abortError)
    }

    if (hasCapabilityCleanupError) {
      errors.push(capabilityCleanupError)
    }

    if (hasCleanupError) {
      errors.push(cleanupError)
    }

    if (errors.length === 1) {
      throw errors[0]
    }

    if (errors.length > 1) {
      throw new AggregateError(
        errors,
        `OpenCode session ${sessionId} failed during execution and cleanup`,
      )
    }

    if (!response) {
      throw new Error(`OpenCode session ${sessionId} produced no response`)
    }

    return response
  }

  /**
   * Selects only validated, user-visible text from OpenCode response parts.
   */
  private static visibleText(result: OpenCodeSessionPromptResult): string {
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

      if (
        type !== "text" ||
        synthetic === true ||
        ignored === true
      ) {
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
