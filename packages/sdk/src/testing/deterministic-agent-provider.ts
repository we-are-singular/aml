import type { AgentExecutionContext } from "../components/agent/agent-execution-context.js"
import type { AgentProvider } from "../components/agent/agent-provider.js"
import type { AgentRequest } from "../components/agent/agent-request.js"
import type { AgentResponse } from "../components/agent/agent-response.js"

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
    callIndex: number,
  ) => AgentResponse | PromiseLike<AgentResponse>
  readonly name: string

  constructor(
    options: {
      readonly name?: string
      readonly respond?: (
        request: AgentRequest,
        context: AgentExecutionContext,
        callIndex: number,
      ) => AgentResponse | PromiseLike<AgentResponse>
    } = {},
  ) {
    const name = options.name ?? "deterministic"

    if (name.length === 0) {
      throw new TypeError(
        "Deterministic Agent provider name must not be empty",
      )
    }

    if (name !== name.trim()) {
      throw new TypeError(
        "Deterministic Agent provider name must already be normalized",
      )
    }

    this.name = name
    this.#respond =
      options.respond ?? ((request) => ({ text: request.prompt }))
  }

  get calls(): readonly Readonly<{
    context: AgentExecutionContext
    request: AgentRequest
  }>[] {
    return this.#calls
  }

  async run(
    request: AgentRequest,
    context: AgentExecutionContext,
  ): Promise<AgentResponse> {
    const callIndex = this.#calls.length
    this.#calls.push(Object.freeze({ context, request }))
    return await this.#respond(request, context, callIndex)
  }
}
