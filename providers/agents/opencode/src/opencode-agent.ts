import {
  defineAgentProvider,
  type AgentExecutionContext,
  type AgentProvider,
  type AgentRequest,
  type AgentResponse,
} from "@aml-jsx/sdk"

import { createIsolatedOpencode } from "./create-isolated-opencode.js"
import {
  captureOpenCodeAgentOptions,
  type CapturedOpenCodeAgentOptions,
  type OpenCodeAgentOptions,
  type OpenCodeServerOptions,
} from "./opencode-agent-options.js"
import { OpenCodeSdkClient } from "./opencode-sdk-client.js"
import type { OpenCodeSessionClient } from "./opencode-session-client.js"
import { OpenCodeSession } from "./opencode-session.js"

/**
 * Configured OpenCode strategy with runtime-managed evaluation cleanup.
 */
export interface OpenCodeAgentProvider extends AgentProvider {
  readonly name: "opencode"

  /**
   * Permanently shuts down direct provider use outside normal AML evaluation.
   */
  close(): Promise<void>
}

interface OpenCodeEvaluationState {
  readonly activeRuns: Set<Promise<AgentResponse>>
  closePromise?: Promise<void>
  clientPromise?: Promise<OpenCodeSessionClient>
  ownedServer?: { close(): Promise<void> | void }
}

class OpenCodeAgentImplementation implements OpenCodeAgentProvider {
  readonly #directory: string | undefined
  readonly #evaluations = new Map<string, OpenCodeEvaluationState>()
  readonly #model: string | undefined
  readonly #serverOptions: OpenCodeServerOptions | undefined
  readonly #sessionClient: OpenCodeSessionClient | undefined
  #closePromise: Promise<void> | undefined
  #closed = false
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
  async run(request: AgentRequest, context: AgentExecutionContext): Promise<AgentResponse> {
    if (this.#closed) {
      throw new Error("OpenCode Agent provider is closed")
    }

    const evaluation = this.#getEvaluation(context)
    const execution = this.#run(request, context, evaluation)
    evaluation.activeRuns.add(execution)

    try {
      return await execution
    } finally {
      evaluation.activeRuns.delete(execution)
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
    evaluation: OpenCodeEvaluationState
  ): Promise<AgentResponse> {
    // OpenCode disconnects dynamic MCP clients but retains their configuration.
    // JavaScript Tools and MCP grants therefore require a disposable host.
    if (
      !this.#sessionClient &&
      (request.mcpServers.length > 0 || request.tools.some(tool => tool.kind === "javascript"))
    ) {
      return await this.#runWithDisposableServer(request, context)
    }

    const client = await this.#getClient(evaluation)
    return await new OpenCodeSession(client, {
      ...(this.#directory === undefined ? {} : { directory: this.#directory }),
      ...(this.#model === undefined ? {} : { model: this.#model }),
    }).run(request, context)
  }

  /**
   * Owns one temporary OpenCode server for dynamic Agent capabilities.
   */
  async #runWithDisposableServer(request: AgentRequest, context: AgentExecutionContext): Promise<AgentResponse> {
    // This server is deliberately not stored in evaluation state: its lifetime
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
        ...(this.#directory === undefined ? {} : { directory: this.#directory }),
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
        "OpenCode disposable server execution and cleanup failed"
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
  async #getClient(evaluation: OpenCodeEvaluationState): Promise<OpenCodeSessionClient> {
    // An injected port owns its own OpenCode host and attachment semantics.
    if (this.#sessionClient) {
      return this.#sessionClient
    }

    // Share one startup barrier across concurrent calls, but permit retry after
    // a failed startup because no reusable client was established.
    evaluation.clientPromise ??= this.#createClient(evaluation).catch((error: unknown) => {
      delete evaluation.clientPromise
      throw error
    })

    return await evaluation.clientPromise
  }

  /**
   * Returns the state shared only by Agents in one AML evaluation.
   */
  #getEvaluation(context: AgentExecutionContext): OpenCodeEvaluationState {
    const runId = context.trace.runId
    const existing = this.#evaluations.get(runId)

    if (existing !== undefined) {
      return existing
    }

    const evaluation: OpenCodeEvaluationState = {
      activeRuns: new Set(),
    }
    this.#evaluations.set(runId, evaluation)

    // The runtime owns the evaluation boundary. Register cleanup on its event
    // scope instead of adding lifecycle methods to the provider contract.
    context.events.once("finish", async () => await this.#finishEvaluation(runId))

    return evaluation
  }

  /**
   * Starts one evaluation-scoped reusable OpenCode host.
   */
  async #createClient(evaluation: OpenCodeEvaluationState): Promise<OpenCodeSessionClient> {
    const owned = await createIsolatedOpencode(this.#serverOptions === undefined ? {} : { ...this.#serverOptions })
    evaluation.ownedServer = owned.server
    return new OpenCodeSdkClient(owned.client)
  }

  /**
   * Returns one cleanup barrier for a completed evaluation.
   */
  #finishEvaluation(runId: string): Promise<void> {
    const evaluation = this.#evaluations.get(runId)

    if (evaluation === undefined) {
      return Promise.resolve()
    }

    evaluation.closePromise ??= this.#closeEvaluation(runId, evaluation)
    return evaluation.closePromise
  }

  /**
   * Waits for evaluation calls before releasing their shared host.
   */
  async #closeEvaluation(runId: string, evaluation: OpenCodeEvaluationState): Promise<void> {
    await Promise.allSettled(evaluation.activeRuns)

    try {
      await evaluation.ownedServer?.close()
    } finally {
      if (this.#evaluations.get(runId) === evaluation) {
        this.#evaluations.delete(runId)
      }
    }
  }

  /**
   * Permanently closes every evaluation still owned by this provider.
   */
  async #close(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.#evaluations.keys()].map(async runId => await this.#finishEvaluation(runId))
    )
    const errors = results.flatMap(result => (result.status === "rejected" ? [result.reason] : []))

    if (errors.length === 1) {
      throw errors[0]
    }

    if (errors.length > 1) {
      throw new AggregateError(errors, "OpenCode Agent provider cleanup failed")
    }
  }
}

/**
 * Configures one immutable OpenCode Agent adapter without performing I/O.
 *
 * Network and process resources remain lazy so importing or authoring an AML
 * tree cannot start an OpenCode server.
 */
export function opencodeAgent(options: OpenCodeAgentOptions = {}): OpenCodeAgentProvider {
  const captured = captureOpenCodeAgentOptions(options)

  return defineAgentProvider(new OpenCodeAgentImplementation(captured))
}
