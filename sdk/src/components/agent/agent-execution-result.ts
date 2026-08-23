import { ComponentEvaluationContext } from "../../core/component-evaluation-context.js"
import { EvaluationError } from "../../core/evaluation-error.js"
import type { AmlTraceAttribute } from "../../observability/trace-event.js"
import { agentDiagnosticIdentity } from "./agent-diagnostic-identity.js"
import type { ModelSchema } from "./model-schema.js"
import type { AgentResponse } from "./agent-response.js"
import type { ValidatedAgentProvider } from "./validate-agent-provider.js"

type TraceAttributes = Readonly<Record<string, AmlTraceAttribute>>

/**
 * Validated provider result plus immutable Agent trace metadata.
 */
export class AgentExecutionResult {
  readonly response: Readonly<AgentResponse>
  readonly traceAttributes: TraceAttributes
  readonly traceContent: TraceAttributes

  private constructor(
    response: Readonly<AgentResponse>,
    traceAttributes: TraceAttributes,
    traceContent: TraceAttributes
  ) {
    this.response = response
    this.traceAttributes = traceAttributes
    this.traceContent = traceContent
    Object.freeze(this)
  }

  /**
   * Captures external response fields once and validates structured output.
   */
  static async from(input: {
    readonly mcpServers: number
    readonly model: string | undefined
    readonly name: string | undefined
    readonly output: ModelSchema<unknown> | undefined
    readonly prompt: string
    readonly provider: Readonly<ValidatedAgentProvider>
    readonly response: AgentResponse
    readonly spanId: string
    readonly system: string
    readonly tools: number
    readonly turns: number
  }): Promise<AgentExecutionResult> {
    const identity = agentDiagnosticIdentity({
      name: input.name,
      provider: input.provider.name,
      spanId: input.spanId,
    })
    const invalidResponse = `${identity} returned an invalid response`

    if (typeof input.response !== "object" || input.response === null) {
      throw new EvaluationError(invalidResponse)
    }

    let text: unknown

    try {
      // External getters are read once before the response crosses into AML.
      text = ComponentEvaluationContext.withoutAccess(
        () =>
          (
            input.response as {
              readonly text?: unknown
            }
          ).text
      )
    } catch (cause) {
      throw new EvaluationError(invalidResponse, { cause })
    }

    if (typeof text !== "string") {
      throw new EvaluationError(invalidResponse)
    }

    let response: Readonly<AgentResponse>

    if (input.output === undefined) {
      response = Object.freeze({ text })
    } else {
      response = Object.freeze({
        structured: await AgentExecutionResult.#structured(
          input.response,
          input.output,
          input.name,
          input.provider.name,
          input.spanId
        ),
        text,
      })
    }

    return new AgentExecutionResult(
      response,
      Object.freeze({
        mcpServers: input.mcpServers,
        ...(input.model === undefined ? {} : { model: input.model }),
        ...(input.name === undefined ? {} : { name: input.name }),
        provider: input.provider.name,
        tools: input.tools,
        turns: input.turns,
      }),
      Object.freeze({
        output: text,
        prompt: input.prompt,
        system: input.system,
      })
    )
  }

  /**
   * Extracts and validates one provider-owned structured result.
   */
  static async #structured(
    response: AgentResponse,
    output: ModelSchema<unknown>,
    name: string | undefined,
    provider: string,
    spanId: string
  ): Promise<unknown> {
    let present: boolean
    let structured: unknown

    try {
      const captured = ComponentEvaluationContext.withoutAccess(() => {
        const hasStructured = Reflect.has(response, "structured")

        return {
          present: hasStructured,
          structured: hasStructured ? Reflect.get(response, "structured") : undefined,
        }
      })
      present = captured.present
      structured = captured.structured
    } catch (cause) {
      throw new EvaluationError(
        `${agentDiagnosticIdentity({ name, provider, spanId })} returned an invalid structured response`,
        { cause }
      )
    }

    if (!present) {
      throw new EvaluationError(`${agentDiagnosticIdentity({ name, provider, spanId })} omitted structured output`)
    }

    try {
      // Schema thenables and nested accessors stay outside component authority.
      return await ComponentEvaluationContext.withoutAccess(async () => await output.validate(structured))
    } catch (cause) {
      throw new EvaluationError(
        `${agentDiagnosticIdentity({ name, provider, spanId })} returned invalid structured output`,
        {
          cause,
        }
      )
    }
  }
}
