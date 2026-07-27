import type { EvaluationContext } from "../../core/evaluation-context.js"
import { EvaluationError } from "../../core/evaluation-error.js"
import type { AmlTraceIdentity } from "../../core/trace-identity.js"
import type { AgentExecutionContext } from "./agent-execution-context.js"
import type { AgentProps } from "./agent.js"
import type { AgentProvider } from "./agent-provider.js"
import type { AgentRequest } from "./agent-request.js"
import type { AgentResponse } from "./agent-response.js"
import {
  type ValidatedAgentProvider,
  validateAgentProvider,
} from "./validate-agent-provider.js"

/**
 * Owns Agent-specific validation, request assembly, and provider execution.
 */
export class AgentExecutor {
  readonly #agentProvider: Readonly<ValidatedAgentProvider> | undefined
  readonly #system: string

  /**
   * Captures runtime-wide Agent defaults and their provider boundary.
   */
  constructor(options: {
    readonly agentProvider?: AgentProvider
    readonly system?: string
  }) {
    if (options.system !== undefined && typeof options.system !== "string") {
      throw new TypeError("system must be a string")
    }

    this.#agentProvider =
      options.agentProvider === undefined
        ? undefined
        : validateAgentProvider(options.agentProvider)
    this.#system = options.system ?? ""
  }

  /**
   * Validates portable Agent props before any descendants execute.
   */
  validateProps(
    props: Readonly<AgentProps>,
  ): Readonly<ValidatedAgentProvider> | undefined {
    if (props.model !== undefined && typeof props.model !== "string") {
      throw new EvaluationError("<Agent> model must be a string")
    }

    if (props.system !== undefined && typeof props.system !== "string") {
      throw new EvaluationError("<Agent> system must be a string")
    }

    return props.provider === undefined
      ? this.#agentProvider
      : validateAgentProvider(props.provider)
  }

  /**
   * Builds and runs one complete provider-neutral Agent request.
   */
  async execute(input: {
    readonly context: EvaluationContext
    readonly prompt: string
    readonly provider: Readonly<ValidatedAgentProvider> | undefined
    readonly props: Readonly<AgentProps>
    readonly systemFragments: readonly string[]
    readonly tools: readonly import("../tool/agent-tool.js").AgentTool[]
    readonly trace: AmlTraceIdentity
  }): Promise<string> {
    if (!input.provider) {
      throw new EvaluationError(
        `Agent ${input.trace.spanId} has no provider`,
      )
    }

    // Fixed system text precedes asynchronously resolved <System> fragments.
    const systemFragments: string[] = []

    for (const fixedSystem of [this.#system, input.props.system]) {
      const text = fixedSystem?.trim()

      if (text) {
        systemFragments.push(text)
      }
    }

    systemFragments.push(...input.systemFragments)

    const request: AgentRequest = Object.freeze({
      ...(input.props.model === undefined
        ? {}
        : { model: input.props.model }),
      prompt: input.prompt.trim(),
      system: systemFragments.join("\n"),
      tools: input.tools,
      trace: input.trace,
    })
    const agentContext: AgentExecutionContext = Object.freeze({
      signal: input.context.signal,
      trace: input.trace,
    })

    // Reserve only after the complete plan exists and immediately before the
    // provider boundary, so rejected descendants do not consume call budget.
    input.context.reserveAgentCall(input.trace)

    let response: AgentResponse

    try {
      response = await Reflect.apply(
        input.provider.run,
        input.provider.provider,
        [request, agentContext],
      )
    } catch (cause) {
      throw new EvaluationError(
        `Agent "${input.provider.name}" (${input.trace.spanId}) failed`,
        { cause },
      )
    }

    if (typeof response !== "object" || response === null) {
      throw new EvaluationError(
        `Agent "${input.provider.name}" (${input.trace.spanId}) returned an invalid response`,
      )
    }

    // Provider objects are external values: read response text once so getters
    // cannot return a different value after validation.
    let text: unknown

    try {
      text = (response as { readonly text?: unknown }).text
    } catch (cause) {
      throw new EvaluationError(
        `Agent "${input.provider.name}" (${input.trace.spanId}) returned an invalid response`,
        { cause },
      )
    }

    if (typeof text !== "string") {
      throw new EvaluationError(
        `Agent "${input.provider.name}" (${input.trace.spanId}) returned an invalid response`,
      )
    }

    return text
  }
}
