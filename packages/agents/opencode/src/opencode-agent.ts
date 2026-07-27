import {
  defineAgentProvider,
  type AgentExecutionContext,
  type AgentProvider,
  type AgentRequest,
  type AgentResponse,
} from "@aml/sdk"

import { createIsolatedOpencode } from "./create-isolated-opencode.js"
import { OpenCodeSdkClient } from "./opencode-sdk-client.js"
import type {
  OpenCodeCapabilityAttachment,
  OpenCodeCapabilityAttachmentInput,
  OpenCodeSessionClient,
  OpenCodeSessionCreateInput,
  OpenCodeSessionLocation,
  OpenCodeSessionPromptInput,
  OpenCodeSessionPromptResult,
} from "./opencode-session-client.js"
import { OpenCodeSession } from "./opencode-session.js"

/**
 * Vendor-owned settings for a package-created local OpenCode server.
 */
export interface OpenCodeServerOptions {
  readonly hostname?: string

  /**
   * Fixed port for the reusable host; dynamic-capability hosts use port 0.
   */
  readonly port?: number
  readonly timeout?: number
}

/**
 * Configures the OpenCode adapter and its resource ownership.
 */
export interface OpenCodeAgentOptions {
  readonly directory?: string
  readonly model?: string
  readonly server?: OpenCodeServerOptions
  readonly sessionClient?: OpenCodeSessionClient
}

/**
 * Configured OpenCode strategy with explicit lifecycle cleanup.
 */
export interface OpenCodeAgentProvider extends AgentProvider {
  readonly name: "opencode"

  /**
   * Waits for active calls and releases only resources owned by this adapter.
   */
  close(): Promise<void>
}

interface CapturedOpenCodeAgentOptions {
  readonly directory?: string
  readonly model?: string
  readonly server?: Readonly<OpenCodeServerOptions>
  readonly sessionClient?: OpenCodeSessionClient
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
  #ownedServer:
    | { close(): Promise<void> | void }
    | undefined
  readonly name = "opencode" as const

  /**
   * Captures adapter configuration without creating an OpenCode server.
   */
  constructor(options: CapturedOpenCodeAgentOptions) {
    this.#directory = options.directory
    this.#model = options.model
    this.#serverOptions = options.server
    this.#sessionClient = options.sessionClient
  }

  /**
   * Runs one Agent while registering it with the provider close barrier.
   */
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

  /**
   * Rejects future work and returns one shared cleanup promise to every caller.
   */
  close(): Promise<void> {
    this.#closed = true
    this.#closePromise ??= this.#close()
    return this.#closePromise
  }

  /**
   * Selects a reusable or invocation-scoped host from the requested capabilities.
   */
  async #run(
    request: AgentRequest,
    context: AgentExecutionContext,
  ): Promise<AgentResponse> {
    // OpenCode disconnects dynamic MCP clients but retains their configuration.
    // JavaScript Tools and MCP grants therefore require a disposable host.
    if (
      !this.#sessionClient &&
      (request.mcpServers.length > 0 ||
        request.tools.some((tool) => tool.kind === "javascript"))
    ) {
      return await this.#runWithDisposableServer(request, context)
    }

    const client = await this.#getClient()
    return await new OpenCodeSession(client, {
      ...(this.#directory === undefined
        ? {}
        : { directory: this.#directory }),
      ...(this.#model === undefined ? {} : { model: this.#model }),
    }).run(request, context)
  }

  /**
   * Owns one temporary OpenCode server for dynamic Agent capabilities.
   */
  async #runWithDisposableServer(
    request: AgentRequest,
    context: AgentExecutionContext,
  ): Promise<AgentResponse> {
    // This server is deliberately not assigned to #ownedServer: its lifetime
    // belongs to this invocation and must end even when the session fails.
    const owned = await createIsolatedOpencode({
      ...(this.#serverOptions === undefined ? {} : this.#serverOptions),
      // Disposable hosts must not contend with the reusable configured port or
      // with another concurrent dynamic-capability invocation.
      port: 0,
    })
    const client = new OpenCodeSdkClient(owned.client)
    let hasExecutionError = false
    let executionError: unknown
    let response: AgentResponse | undefined

    // Keep execution and server shutdown errors separately so neither masks the
    // other at this distributed resource boundary.
    try {
      response = await new OpenCodeSession(client, {
        ...(this.#directory === undefined
          ? {}
          : { directory: this.#directory }),
        ...(this.#model === undefined ? {} : { model: this.#model }),
      }).run(request, context)
    } catch (error) {
      hasExecutionError = true
      executionError = error
    }

    let hasCleanupError = false
    let cleanupError: unknown

    try {
      await owned.server.close()
    } catch (error) {
      hasCleanupError = true
      cleanupError = error
    }

    if (hasExecutionError && hasCleanupError) {
      throw new AggregateError(
        [executionError, cleanupError],
        "OpenCode disposable server execution and cleanup failed",
      )
    }

    if (hasExecutionError) {
      throw executionError
    }

    if (hasCleanupError) {
      throw cleanupError
    }

    if (!response) {
      throw new Error("OpenCode disposable server produced no response")
    }

    return response
  }

  /**
   * Returns the injected client or one lazily shared package-owned client.
   */
  async #getClient(): Promise<OpenCodeSessionClient> {
    // An injected port owns its own OpenCode host and attachment semantics.
    if (this.#sessionClient) {
      return this.#sessionClient
    }

    // Share one startup barrier across concurrent calls, but permit retry after
    // a failed startup because no reusable client was established.
    this.#clientPromise ??= this.#createClient().catch((error: unknown) => {
      this.#clientPromise = undefined
      throw error
    })

    return await this.#clientPromise
  }

  /**
   * Starts the reusable OpenCode host and records package ownership for close().
   */
  async #createClient(): Promise<OpenCodeSessionClient> {
    const owned = await createIsolatedOpencode(
      this.#serverOptions === undefined ? {} : { ...this.#serverOptions },
    )
    this.#ownedServer = owned.server
    return new OpenCodeSdkClient(owned.client)
  }

  /**
   * Waits for invocation cleanup before releasing the reusable host.
   */
  async #close(): Promise<void> {
    // Active calls include their invocation-scoped cleanup. Closing the shared
    // server earlier could strand their session deletion requests.
    await Promise.allSettled(this.#activeRuns)
    await this.#ownedServer?.close()
  }
}

/**
 * Configures one immutable OpenCode Agent adapter without performing I/O.
 *
 * Network and process resources remain lazy so importing or authoring an AML
 * tree cannot start an OpenCode server.
 */
export function opencodeAgent(
  options: OpenCodeAgentOptions = {},
): OpenCodeAgentProvider {
  const captured = captureOptions(options)

  return defineAgentProvider(
    new OpenCodeAgentImplementation(captured),
  )
}

/**
 * Validates and snapshots provider configuration at the factory boundary.
 */
function captureOptions(
  options: OpenCodeAgentOptions,
): Readonly<CapturedOpenCodeAgentOptions> {
  if (typeof options !== "object" || options === null) {
    throw new TypeError("OpenCode Agent options must be an object")
  }

  // Capture every external property once. Accessor-backed configuration must
  // not validate one authority and substitute another when the Agent runs.
  const directory = options.directory
  const model = options.model
  const serverValue = options.server
  const sessionClientValue = options.sessionClient

  // Portable model parsing happens synchronously so invalid configured
  // identities never reach server or session creation.
  if (
    directory !== undefined &&
    (typeof directory !== "string" ||
      directory.length === 0)
  ) {
    throw new TypeError("OpenCode directory must be a non-empty string")
  }

  OpenCodeSession.parseModel(model)

  if (serverValue !== undefined && sessionClientValue !== undefined) {
    throw new TypeError(
      "OpenCode server and sessionClient options are mutually exclusive",
    )
  }

  const server =
    serverValue === undefined
      ? undefined
      : captureServerOptions(serverValue)
  const sessionClient =
    sessionClientValue === undefined
      ? undefined
      : captureSessionClient(sessionClientValue)

  return Object.freeze({
    ...(directory === undefined ? {} : { directory }),
    ...(model === undefined ? {} : { model }),
    ...(server === undefined ? {} : { server }),
    ...(sessionClient === undefined ? {} : { sessionClient }),
  })
}

/**
 * Snapshots child-host configuration without retaining external accessors.
 */
function captureServerOptions(
  value: OpenCodeServerOptions,
): Readonly<OpenCodeServerOptions> {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("OpenCode server options must be an object")
  }

  const hostname = value.hostname
  const port = value.port
  const timeout = value.timeout

  if (
    hostname !== undefined &&
    (typeof hostname !== "string" || hostname.length === 0)
  ) {
    throw new TypeError(
      "OpenCode server hostname must be a non-empty string",
    )
  }

  if (
    port !== undefined &&
    (!Number.isSafeInteger(port) || port < 0 || port > 65_535)
  ) {
    throw new TypeError(
      "OpenCode server port must be an integer between 0 and 65535",
    )
  }

  if (
    timeout !== undefined &&
    (!Number.isSafeInteger(timeout) || timeout < 0)
  ) {
    throw new TypeError(
      "OpenCode server timeout must be a non-negative safe integer",
    )
  }

  return Object.freeze({
    ...(hostname === undefined ? {} : { hostname }),
    ...(port === undefined ? {} : { port }),
    ...(timeout === undefined ? {} : { timeout }),
  })
}

/**
 * Captures an injected session port and binds each method to its original owner.
 */
function captureSessionClient(
  value: OpenCodeSessionClient,
): OpenCodeSessionClient {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("OpenCode sessionClient must be an object")
  }

  // Method getters are another authority boundary. Resolve each exactly once
  // before any remote session exists, then expose a stable AML-owned facade.
  const abort = captureSessionClientMethod(value, "abort")
  const attachCapabilities = captureSessionClientMethod(
    value,
    "attachCapabilities",
  )
  const create = captureSessionClientMethod(value, "create")
  const deleteSession = captureSessionClientMethod(value, "delete")
  const prompt = captureSessionClientMethod(value, "prompt")

  return Object.freeze({
    abort(input: OpenCodeSessionLocation): Promise<void> {
      return Reflect.apply(abort, value, [input])
    },
    attachCapabilities(
      input: OpenCodeCapabilityAttachmentInput,
      signal: AbortSignal,
    ): Promise<OpenCodeCapabilityAttachment> {
      return Reflect.apply(attachCapabilities, value, [input, signal])
    },
    create(
      input: OpenCodeSessionCreateInput,
      signal: AbortSignal,
    ): Promise<string> {
      return Reflect.apply(create, value, [input, signal])
    },
    delete(input: OpenCodeSessionLocation): Promise<void> {
      return Reflect.apply(deleteSession, value, [input])
    },
    prompt(
      input: OpenCodeSessionPromptInput,
      signal: AbortSignal,
    ): Promise<OpenCodeSessionPromptResult> {
      return Reflect.apply(prompt, value, [input, signal])
    },
  })
}

/**
 * Reads one injected port method without allowing validation/use substitution.
 */
function captureSessionClientMethod<
  Name extends keyof OpenCodeSessionClient,
>(
  client: OpenCodeSessionClient,
  name: Name,
): OpenCodeSessionClient[Name] {
  let method: unknown

  try {
    method = Reflect.get(client, name)
  } catch (cause) {
    throw new TypeError(
      `OpenCode sessionClient ${name} must be readable`,
      { cause },
    )
  }

  if (typeof method !== "function") {
    throw new TypeError(
      `OpenCode sessionClient ${name} must be a function`,
    )
  }

  return method as OpenCodeSessionClient[Name]
}
