import type { OpencodeClient } from "@opencode-ai/sdk/v2"

import type {
  OpenCodeSessionClient,
  OpenCodeSessionCreateInput,
  OpenCodeSessionLocation,
  OpenCodeSessionPromptInput,
  OpenCodeSessionPromptResult,
} from "./opencode-session-client.js"

/**
 * Maps the generated OpenCode v2 client into AML's small session port.
 */
export class OpenCodeSdkClient implements OpenCodeSessionClient {
  readonly #client: OpencodeClient

  constructor(client: OpencodeClient) {
    this.#client = client
  }

  async create(
    input: OpenCodeSessionCreateInput,
    signal: AbortSignal,
  ): Promise<string> {
    const { data } = await this.#client.session.create(
      {
        ...(input.directory === undefined
          ? {}
          : { directory: input.directory }),
        ...(input.model === undefined
          ? {}
          : {
              model: {
                id: input.model.modelId,
                providerID: input.model.providerId,
              },
            }),
        title: input.title,
      },
      { signal, throwOnError: true },
    )

    const rawData: unknown = data

    if (typeof rawData !== "object" || rawData === null) {
      throw new TypeError("OpenCode returned invalid session data")
    }

    const id = (rawData as { readonly id?: unknown }).id

    if (typeof id !== "string" || id.length === 0) {
      throw new TypeError("OpenCode returned an invalid session ID")
    }

    return id
  }

  async prompt(
    input: OpenCodeSessionPromptInput,
    signal: AbortSignal,
  ): Promise<OpenCodeSessionPromptResult> {
    const { data } = await this.#client.session.prompt(
      {
        ...(input.directory === undefined
          ? {}
          : { directory: input.directory }),
        ...(input.model === undefined
          ? {}
          : {
              model: {
                modelID: input.model.modelId,
                providerID: input.model.providerId,
              },
            }),
        parts: [{ text: input.prompt, type: "text" }],
        sessionID: input.sessionId,
        system: input.system,
        tools: { ...input.tools },
      },
      { signal, throwOnError: true },
    )

    const rawData: unknown = data

    if (typeof rawData !== "object" || rawData === null) {
      throw new TypeError("OpenCode returned invalid prompt data")
    }

    const info = (rawData as { readonly info?: unknown }).info

    if (typeof info !== "object" || info === null) {
      throw new TypeError("OpenCode returned invalid assistant metadata")
    }

    const error = (info as { readonly error?: unknown }).error
    const parts = (rawData as { readonly parts?: unknown }).parts

    if (!Array.isArray(parts)) {
      throw new TypeError("OpenCode returned invalid prompt parts")
    }

    return Object.freeze({
      ...(error === undefined ? {} : { error }),
      parts: Object.freeze([...parts]),
    })
  }

  async abort(input: OpenCodeSessionLocation): Promise<void> {
    const { data } = await this.#client.session.abort(
      {
        ...(input.directory === undefined
          ? {}
          : { directory: input.directory }),
        sessionID: input.sessionId,
      },
      { throwOnError: true },
    )

    if (data !== true) {
      throw new Error(`OpenCode did not abort session ${input.sessionId}`)
    }
  }

  async delete(input: OpenCodeSessionLocation): Promise<void> {
    const { data } = await this.#client.session.delete(
      {
        ...(input.directory === undefined
          ? {}
          : { directory: input.directory }),
        sessionID: input.sessionId,
      },
      { throwOnError: true },
    )

    if (data !== true) {
      throw new Error(`OpenCode did not delete session ${input.sessionId}`)
    }
  }
}
