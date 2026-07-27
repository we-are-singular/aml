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

  constructor(
    client: OpenCodeSessionClient,
    options: OpenCodeSessionOptions,
  ) {
    this.#client = client
    this.#directory = options.directory
    this.#model = options.model
  }

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

  async run(
    request: AgentRequest,
    context: AgentExecutionContext,
  ): Promise<AgentResponse> {
    context.signal.throwIfAborted()

    const model = OpenCodeSession.parseModel(request.model ?? this.#model)
    const sessionId = await this.#client.create(
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

    try {
      const result = await this.#client.prompt(
        {
          ...location,
          ...(model === undefined ? {} : { model }),
          prompt: request.prompt,
          system: request.system,
          tools: { "*": false },
        },
        context.signal,
      )

      context.signal.throwIfAborted()
      response = Object.freeze({ text: OpenCodeSession.visibleText(result) })
    } catch (error) {
      hasExecutionError = true
      executionError = error
    } finally {
      context.signal.removeEventListener("abort", requestAbort)
    }

    await abortPromise

    let hasCleanupError = false
    let cleanupError: unknown

    try {
      await this.#client.delete(location)
    } catch (error) {
      hasCleanupError = true
      cleanupError = error
    }

    const errors: unknown[] = []

    if (hasExecutionError) {
      errors.push(executionError)
    }

    if (hasAbortError) {
      errors.push(abortError)
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
