import { createOpencode } from "@opencode-ai/sdk/v2"
import {
  defineAgentProvider,
  type AgentExecutionContext,
  type AgentProvider,
  type AgentRequest,
  type AgentResponse,
} from "@aml/sdk"

import { OpenCodeSdkClient } from "./opencode-sdk-client.js"
import type { OpenCodeSessionClient } from "./opencode-session-client.js"
import { OpenCodeSession } from "./opencode-session.js"

export interface OpenCodeServerOptions {
  readonly hostname?: string
  readonly port?: number
  readonly timeout?: number
}

export interface OpenCodeAgentOptions {
  readonly directory?: string
  readonly model?: string
  readonly server?: OpenCodeServerOptions
  readonly sessionClient?: OpenCodeSessionClient
}

export interface OpenCodeAgentProvider extends AgentProvider {
  readonly name: "opencode"
  close(): Promise<void>
}

class OpenCodeAgentImplementation implements OpenCodeAgentProvider {
  readonly #activeRuns = new Set<Promise<AgentResponse>>()
  readonly #directory: string | undefined
  readonly #model: string | undefined
  readonly #serverOptions: OpenCodeServerOptions | undefined
  readonly #sessionClient: OpenCodeSessionClient | undefined
  #clientPromise: Promise<OpenCodeSessionClient> | undefined
  #closePromise: Promise<void> | undefined
  #closed = false
  #ownedServer: { close(): void } | undefined
  readonly name = "opencode" as const

  constructor(options: OpenCodeAgentOptions) {
    this.#directory = options.directory
    this.#model = options.model
    this.#serverOptions = options.server
    this.#sessionClient = options.sessionClient
  }

  async run(
    request: AgentRequest,
    context: AgentExecutionContext,
  ): Promise<AgentResponse> {
    if (this.#closed) {
      throw new Error("OpenCode Agent provider is closed")
    }

    const execution = this.#run(request, context)
    this.#activeRuns.add(execution)

    try {
      return await execution
    } finally {
      this.#activeRuns.delete(execution)
    }
  }

  close(): Promise<void> {
    this.#closed = true
    this.#closePromise ??= this.#close()
    return this.#closePromise
  }

  async #run(
    request: AgentRequest,
    context: AgentExecutionContext,
  ): Promise<AgentResponse> {
    const client = await this.#getClient()
    return await new OpenCodeSession(client, {
      ...(this.#directory === undefined
        ? {}
        : { directory: this.#directory }),
      ...(this.#model === undefined ? {} : { model: this.#model }),
    }).run(request, context)
  }

  async #getClient(): Promise<OpenCodeSessionClient> {
    if (this.#sessionClient) {
      return this.#sessionClient
    }

    this.#clientPromise ??= this.#createClient().catch((error: unknown) => {
      this.#clientPromise = undefined
      throw error
    })

    return await this.#clientPromise
  }

  async #createClient(): Promise<OpenCodeSessionClient> {
    const owned = await createOpencode(
      this.#serverOptions === undefined ? {} : { ...this.#serverOptions },
    )
    this.#ownedServer = owned.server
    return new OpenCodeSdkClient(owned.client)
  }

  async #close(): Promise<void> {
    await Promise.allSettled(this.#activeRuns)
    this.#ownedServer?.close()
  }
}

/**
 * Configures one immutable OpenCode Agent adapter without performing I/O.
 */
export function opencodeAgent(
  options: OpenCodeAgentOptions = {},
): OpenCodeAgentProvider {
  validateOptions(options)
  return defineAgentProvider(
    new OpenCodeAgentImplementation({
      ...(options.directory === undefined
        ? {}
        : { directory: options.directory }),
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.server === undefined
        ? {}
        : { server: Object.freeze({ ...options.server }) }),
      ...(options.sessionClient === undefined
        ? {}
        : { sessionClient: options.sessionClient }),
    }),
  )
}

function validateOptions(options: OpenCodeAgentOptions): void {
  if (
    options.directory !== undefined &&
    (typeof options.directory !== "string" ||
      options.directory.length === 0)
  ) {
    throw new TypeError("OpenCode directory must be a non-empty string")
  }

  OpenCodeSession.parseModel(options.model)

  if (options.server !== undefined && options.sessionClient !== undefined) {
    throw new TypeError(
      "OpenCode server and sessionClient options are mutually exclusive",
    )
  }

  if (options.sessionClient !== undefined) {
    if (
      typeof options.sessionClient !== "object" ||
      options.sessionClient === null
    ) {
      throw new TypeError("OpenCode sessionClient must be an object")
    }

    for (const method of ["abort", "create", "delete", "prompt"] as const) {
      if (typeof options.sessionClient[method] !== "function") {
        throw new TypeError(
          `OpenCode sessionClient ${method} must be a function`,
        )
      }
    }
  }

  if (options.server === undefined) {
    return
  }

  if (typeof options.server !== "object" || options.server === null) {
    throw new TypeError("OpenCode server options must be an object")
  }

  if (
    options.server.hostname !== undefined &&
    (typeof options.server.hostname !== "string" ||
      options.server.hostname.length === 0)
  ) {
    throw new TypeError("OpenCode server hostname must be a non-empty string")
  }

  if (
    options.server.port !== undefined &&
    (!Number.isSafeInteger(options.server.port) ||
      options.server.port < 0 ||
      options.server.port > 65_535)
  ) {
    throw new TypeError(
      "OpenCode server port must be an integer between 0 and 65535",
    )
  }

  if (
    options.server.timeout !== undefined &&
    (!Number.isSafeInteger(options.server.timeout) ||
      options.server.timeout < 0)
  ) {
    throw new TypeError(
      "OpenCode server timeout must be a non-negative safe integer",
    )
  }
}
