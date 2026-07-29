import {
  AbstractAgentProvider,
  defineAgentProvider,
  supportsSandboxRuntime,
  type AgentExecutionContext,
  type AgentProvider,
  type AgentProviderSession,
  type AgentProviderTurn,
  type AgentRequest,
  type AgentResponse,
} from "@aml-jsx/sdk"
import { defu } from "defu"

import { createIsolatedOpencode } from "./create-isolated-opencode.js"
import {
  captureOpenCodeAgentOptions,
  type CapturedOpenCodeAgentOptions,
  type OpenCodeAgentOptions,
  type OpenCodeServerOptions,
} from "./opencode-agent-options.js"
import { OpenCodeSdkClient } from "./opencode-sdk-client.js"
import { OpenCodeSandboxSessionClient } from "./opencode-sandbox-session-client.js"
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
  readonly activeRuns: Set<Promise<void>>
  closePromise?: Promise<void>
  clientPromise?: Promise<OpenCodeSessionClient>
  ownedServer?: { close(): Promise<void> | void }
}

class OpenCodeAgentImplementation extends AbstractAgentProvider<"opencode"> implements OpenCodeAgentProvider {
  readonly #directory: string | undefined
  readonly #config: CapturedOpenCodeAgentOptions["config"]
  readonly #evaluations = new Map<string, OpenCodeEvaluationState>()
  readonly #model: string | undefined
  readonly #serverOptions: OpenCodeServerOptions | undefined
  readonly #sessionClient: OpenCodeSessionClient | undefined
  #closePromise: Promise<void> | undefined
  #closed = false
  /**
   * Captures adapter configuration without creating an OpenCode server.
   */
  constructor(options: CapturedOpenCodeAgentOptions) {
    super("opencode")
    this.#config = options.config
    this.#directory = options.directory
    this.#model = options.model
    this.#serverOptions = options.server
    this.#sessionClient = options.sessionClient
  }

  override supportsSandbox(sandbox: NonNullable<AgentExecutionContext["sandbox"]>): boolean {
    return supportsSandboxRuntime(sandbox)
  }

  /**
   * Opens one Agent session and registers it with the provider close barrier.
   */
  protected async openSession(request: AgentRequest, context: AgentExecutionContext): Promise<AgentProviderSession> {
    if (this.#closed) {
      throw new Error("OpenCode Agent provider is closed")
    }

    const evaluation = this.#getEvaluation(context)
    // Register before opening can suspend so provider.close() cannot miss a
    // server, capability attachment, or conversation still being constructed.
    const barrier = new OpenCodeRunBarrier(evaluation.activeRuns)

    try {
      const session =
        context.sandbox === undefined
          ? await this.#open(request, context, evaluation)
          : await this.#openInSandbox(request, context)
      return new TrackedOpenCodeSession(session, barrier)
    } catch (error) {
      barrier.resolve()
      throw error
    }
  }

  /**
   * Runs an invocation-owned OpenCode CLI beside the Sandbox Workspace.
   */
  async #openInSandbox(request: AgentRequest, context: AgentExecutionContext): Promise<AgentProviderSession> {
    if (this.#directory !== undefined) {
      throw new TypeError("OpenCode directory cannot be combined with AML Sandbox; use Agent cwd")
    }

    if (this.#serverOptions !== undefined) {
      throw new TypeError("OpenCode server options cannot be combined with AML Sandbox")
    }

    if (this.#sessionClient !== undefined) {
      throw new TypeError("OpenCode sessionClient cannot be combined with AML Sandbox")
    }

    const sandbox = context.sandbox

    if (sandbox === undefined) {
      throw new Error("OpenCode Sandbox execution requires an active Sandbox")
    }

    const userInputs = this.#config === undefined ? {} : { config: this.#config }
    const imperativeConfig = { sandbox }
    const client = new OpenCodeSandboxSessionClient(defu(imperativeConfig, userInputs))

    return await this.#session(client).open(request, context)
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
  async #open(
    request: AgentRequest,
    context: AgentExecutionContext,
    evaluation: OpenCodeEvaluationState
  ): Promise<AgentProviderSession> {
    // OpenCode disconnects dynamic MCP clients but retains their configuration.
    // JavaScript Tools and MCP grants therefore require a disposable host.
    if (
      !this.#sessionClient &&
      (request.mcpServers.length > 0 || request.tools.some(tool => tool.kind === "javascript"))
    ) {
      return await this.#openWithDisposableServer(request, context)
    }

    const client = await this.#getClient(evaluation)
    return await this.#session(client).open(request, context)
  }

  /**
   * Owns one temporary OpenCode server for dynamic Agent capabilities.
   */
  async #openWithDisposableServer(
    request: AgentRequest,
    context: AgentExecutionContext
  ): Promise<AgentProviderSession> {
    // This server is deliberately not stored in evaluation state: its lifetime
    // belongs to this invocation and must end even when the session fails.
    // Disposable hosts must not contend with the reusable configured port or
    // with another concurrent dynamic-capability invocation.
    const owned = await createIsolatedOpencode(defu({ port: 0 }, this.#serverInputs()))
    const client = new OpenCodeSdkClient(owned.client)
    try {
      const session = await this.#session(client).open(request, context)
      return new OwnedOpenCodeServerSession(session, owned.server)
    } catch (error) {
      try {
        await owned.server.close()
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "OpenCode disposable server creation and cleanup failed")
      }

      throw error
    }
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
    const owned = await createIsolatedOpencode(this.#serverInputs())
    evaluation.ownedServer = owned.server
    return new OpenCodeSdkClient(owned.client)
  }

  /**
   * Builds the user-controlled server layer without inventing a shared schema.
   */
  #serverInputs(): Parameters<typeof createIsolatedOpencode>[0] {
    return {
      ...(this.#serverOptions === undefined ? {} : this.#serverOptions),
      ...(this.#config === undefined ? {} : { config: this.#config }),
    }
  }

  /**
   * Applies configured defaults to one fresh provider-owned session.
   */
  #session(client: OpenCodeSessionClient): OpenCodeSession {
    return new OpenCodeSession(client, {
      ...(this.#directory === undefined ? {} : { directory: this.#directory }),
      ...(this.#model === undefined ? {} : { model: this.#model }),
    })
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
 * Keeps provider-level close barriers aware of one invocation session.
 */
class TrackedOpenCodeSession implements AgentProviderSession {
  readonly #barrier: OpenCodeRunBarrier
  readonly #session: AgentProviderSession

  constructor(session: AgentProviderSession, barrier: OpenCodeRunBarrier) {
    this.#barrier = barrier
    this.#session = session
  }

  async abort(): Promise<void> {
    await this.#session.abort?.()
  }

  async runTurn(turn: Readonly<AgentProviderTurn>, context: AgentExecutionContext): Promise<AgentResponse> {
    return await this.#session.runTurn(turn, context)
  }

  async close(): Promise<void> {
    try {
      await this.#session.close()
    } finally {
      this.#barrier.resolve()
    }
  }
}

/**
 * Registers one complete opening-through-cleanup lifetime with provider close.
 */
class OpenCodeRunBarrier {
  readonly #activeRuns: Set<Promise<void>>
  readonly #promise: Promise<void>
  readonly #resolvePromise: () => void
  #resolved = false

  constructor(activeRuns: Set<Promise<void>>) {
    this.#activeRuns = activeRuns
    let resolvePromise!: () => void
    this.#promise = new Promise<void>(resolve => {
      resolvePromise = resolve
    })
    this.#resolvePromise = resolvePromise
    activeRuns.add(this.#promise)
  }

  resolve(): void {
    if (this.#resolved) {
      return
    }

    this.#resolved = true
    this.#activeRuns.delete(this.#promise)
    this.#resolvePromise()
  }
}

/**
 * Extends invocation cleanup to a disposable OpenCode host.
 */
class OwnedOpenCodeServerSession implements AgentProviderSession {
  readonly #server: { close(): Promise<void> | void }
  readonly #session: AgentProviderSession

  constructor(session: AgentProviderSession, server: { close(): Promise<void> | void }) {
    this.#server = server
    this.#session = session
  }

  async abort(): Promise<void> {
    await this.#session.abort?.()
  }

  async runTurn(turn: Readonly<AgentProviderTurn>, context: AgentExecutionContext): Promise<AgentResponse> {
    return await this.#session.runTurn(turn, context)
  }

  async close(): Promise<void> {
    const errors: unknown[] = []

    try {
      await this.#session.close()
    } catch (error) {
      errors.push(error)
    }

    try {
      await this.#server.close()
    } catch (error) {
      errors.push(error)
    }

    if (errors.length === 1) {
      throw errors[0]
    }

    if (errors.length > 1) {
      throw new AggregateError(errors, "OpenCode disposable server cleanup failed")
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
