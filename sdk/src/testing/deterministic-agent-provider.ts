import type { AgentExecutionContext } from "../components/agent/agent-execution-context.js"
import type { AgentProvider } from "../components/agent/agent-provider.js"
import type { AgentRequest } from "../components/agent/agent-request.js"
import type { AgentResponse } from "../components/agent/agent-response.js"
import type { SandboxSession } from "../components/sandbox/sandbox-provider.js"

/**
 * Records provider calls and returns deterministic responses in tests/examples.
 */
export class DeterministicAgentProvider implements AgentProvider {
  readonly #calls: {
    readonly context: AgentExecutionContext
    readonly request: AgentRequest
  }[] = []
  readonly #respond: (
    request: AgentRequest,
    context: AgentExecutionContext,
    callIndex: number
  ) => AgentResponse | PromiseLike<AgentResponse>
  readonly #supportsSandbox: ((sandbox: SandboxSession) => boolean) | undefined
  /**
   * Provider identifier recorded in Agent requests and traces.
   *
   * Defaults to `"deterministic"` and must be non-empty and already trimmed.
   */
  readonly name: string

  /**
   * Captures a deterministic response strategy without starting any resources.
   */
  constructor(
    options: {
      /** Provider identifier; defaults to `"deterministic"`. */
      readonly name?: string
      /**
       * Response strategy invoked after the call is recorded.
       *
       * Defaults to returning the request prompt as response text. `callIndex`
       * is zero-based and follows provider execution order.
       */
      readonly respond?: (
        request: AgentRequest,
        context: AgentExecutionContext,
        callIndex: number
      ) => AgentResponse | PromiseLike<AgentResponse>
      /**
       * Sandbox compatibility predicate used by `supportsSandbox()`.
       *
       * Omit to report every Sandbox as unsupported.
       */
      readonly supportsSandbox?: (sandbox: SandboxSession) => boolean
    } = {}
  ) {
    const name = options.name ?? "deterministic"

    if (name.length === 0) {
      throw new TypeError("Deterministic Agent provider name must not be empty")
    }

    if (name !== name.trim()) {
      throw new TypeError("Deterministic Agent provider name must already be normalized")
    }

    this.name = name
    this.#respond = options.respond ?? (request => ({ text: request.prompt }))
    this.#supportsSandbox = options.supportsSandbox
  }

  /**
   * Returns recorded calls in provider execution order for behavioral assertions.
   */
  get calls(): readonly Readonly<{
    /** Execution services and cancellation state supplied for this call. */
    context: AgentExecutionContext

    /** Immutable provider-neutral Agent request received by the test double. */
    request: AgentRequest
  }>[] {
    return this.#calls
  }

  /**
   * Records one immutable call snapshot before invoking the response strategy.
   */
  async run(request: AgentRequest, context: AgentExecutionContext): Promise<AgentResponse> {
    context.signal.throwIfAborted()
    const callIndex = this.#calls.length
    this.#calls.push(Object.freeze({ context, request }))
    return await this.#respond(request, context, callIndex)
  }

  /**
   * Applies the configured compatibility policy to an effective Sandbox.
   */
  supportsSandbox(sandbox: SandboxSession): boolean {
    return this.#supportsSandbox?.(sandbox) === true
  }
}
