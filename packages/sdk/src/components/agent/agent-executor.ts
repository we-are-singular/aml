import { ComponentEvaluationContext } from "../../core/component-evaluation-context.js"
import type { EvaluationContext } from "../../core/evaluation-context.js"
import { EvaluationError } from "../../core/evaluation-error.js"
import type { AmlTraceIdentity } from "../../core/trace-identity.js"
import type { SandboxSession } from "../sandbox/sandbox-provider.js"
import type { AgentMcpServer } from "../mcp/aml-mcp-server.js"
import type { AgentExecutionContext } from "./agent-execution-context.js"
import type { ModelSchema } from "./model-schema.js"
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
  readonly #maxTurnsPerAgent: number
  readonly #system: string

  /**
   * Captures runtime-wide Agent defaults and their provider boundary.
   */
  constructor(options: {
    readonly agentProvider?: AgentProvider
    readonly maxTurnsPerAgent: number
    readonly system?: string
  }) {
    if (options.system !== undefined && typeof options.system !== "string") {
      throw new TypeError("system must be a string")
    }

    this.#agentProvider =
      options.agentProvider === undefined
        ? undefined
        : validateAgentProvider(options.agentProvider)
    this.#maxTurnsPerAgent = options.maxTurnsPerAgent
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

    const explicitProvider = props.provider

    return explicitProvider === undefined
      ? this.#agentProvider
      : ComponentEvaluationContext.withoutAccess(() =>
          validateAgentProvider(explicitProvider),
        )
  }

  /**
   * Builds and runs one complete provider-neutral Agent request.
   */
  async execute(input: {
    readonly context: EvaluationContext
    readonly followUps: readonly string[]
    readonly mcpServers: readonly AgentMcpServer[]
    readonly output?: ModelSchema<unknown>
    readonly prompt: string
    readonly provider: Readonly<ValidatedAgentProvider> | undefined
    readonly props: Readonly<AgentProps>
    readonly sandbox: Readonly<SandboxSession> | undefined
    readonly systemFragments: readonly string[]
    readonly tools: readonly import("../tool/agent-tool.js").AgentTool[]
    readonly trace: AmlTraceIdentity
  }): Promise<AgentResponse> {
    if (!input.provider) {
      throw new EvaluationError(
        `Agent ${input.trace.spanId} has no provider`,
      )
    }

    const provider = input.provider

    // Compatibility is an explicit fail-closed handshake. A provider that
    // ignores the scope would otherwise run model-controlled actions on host.
    if (input.sandbox !== undefined) {
      let supported = false
      const supportsSandbox = provider.supportsSandbox

      try {
        supported =
          supportsSandbox !== undefined &&
          ComponentEvaluationContext.withoutAccess(() =>
            Reflect.apply(
              supportsSandbox,
              provider.provider,
              [input.sandbox],
            ),
          ) === true
      } catch (cause) {
        throw new EvaluationError(
          `Agent provider "${input.provider.name}" failed its Sandbox compatibility check`,
          { cause },
        )
      }

      if (!supported) {
        throw new EvaluationError(
          `Agent provider "${input.provider.name}" cannot run inside Sandbox provider "${input.sandbox.provider.name}"`,
        )
      }
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

    const prompt = input.prompt.trim()
    const followUps = input.followUps.map((followUp) => {
      const text = followUp.trim()

      if (text.length === 0) {
        throw new EvaluationError(
          "<FollowUp> must resolve to non-empty text",
        )
      }

      return text
    })
    const turnCount = 1 + followUps.length

    if (
      this.#maxTurnsPerAgent !== 0 &&
      turnCount > this.#maxTurnsPerAgent
    ) {
      throw new EvaluationError(
        `Agent ${input.trace.spanId} exceeded maxTurnsPerAgent ${this.#maxTurnsPerAgent}`,
      )
    }

    const request: AgentRequest = Object.freeze({
      ...(followUps.length === 0
        ? {}
        : { followUps: Object.freeze(followUps) }),
      ...(input.props.model === undefined
        ? {}
        : { model: input.props.model }),
      mcpServers: input.mcpServers,
      ...(input.output === undefined
        ? {}
        : {
            output: Object.freeze({
              jsonSchema: input.output.jsonSchema,
              type: "json" as const,
            }),
          }),
      prompt,
      system: systemFragments.join("\n"),
      tools: input.tools,
      trace: input.trace,
    })
    const agentContext: AgentExecutionContext = Object.freeze({
      ...(input.sandbox === undefined
        ? {}
        : { sandbox: input.sandbox }),
      signal: input.context.signal,
      trace: input.trace,
    })

    // Reserve only after the complete plan exists. Limit errors belong to AML,
    // not the provider failure boundary below.
    input.context.reserveAgentCall(input.trace)

    let providerStarted = false
    let response: AgentResponse

    try {
      // Scheduling begins only after the complete Agent plan exists. The slot
      // covers provider-owned session and capability cleanup because run()
      // cannot settle until the adapter has finished that lifecycle.
      response = await input.context.scheduleAgent(
        () => {
          providerStarted = true
          // The async wrapper is created inside exit(), so Promise/thenable
          // assimilation and every provider-created continuation remain masked.
          return ComponentEvaluationContext.withoutAccess(async () =>
            await Reflect.apply(
              provider.run,
              provider.provider,
              [request, agentContext],
            ),
          )
        },
      )
    } catch (cause) {
      if (!providerStarted && input.context.signal.aborted) {
        throw new EvaluationError(
          `Agent "${provider.name}" (${input.trace.spanId}) was cancelled before provider execution`,
          { cause },
        )
      }

      throw new EvaluationError(
        `Agent "${provider.name}" (${input.trace.spanId}) failed`,
        { cause },
      )
    }

    if (typeof response !== "object" || response === null) {
      throw new EvaluationError(
        `Agent "${input.provider.name}" (${input.trace.spanId}) returned an invalid response`,
      )
    }

    // Provider objects are external values: read each result field once so
    // stateful getters cannot change a value after boundary validation.
    let text: unknown

    try {
      text = ComponentEvaluationContext.withoutAccess(
        () => (response as { readonly text?: unknown }).text,
      )
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

    if (input.output === undefined) {
      return Object.freeze({ text })
    }

    let hasStructured: boolean
    let structured: unknown

    try {
      const captured = ComponentEvaluationContext.withoutAccess(() => {
        const present = Reflect.has(response, "structured")

        return {
          hasStructured: present,
          structured: present
            ? Reflect.get(response, "structured")
            : undefined,
        }
      })
      hasStructured = captured.hasStructured
      structured = captured.structured
    } catch (cause) {
      throw new EvaluationError(
        `Agent "${input.provider.name}" (${input.trace.spanId}) returned an invalid structured response`,
        { cause },
      )
    }

    if (!hasStructured) {
      throw new EvaluationError(
        `Agent "${input.provider.name}" (${input.trace.spanId}) omitted structured output`,
      )
    }

    let validated: unknown

    try {
      const output = input.output

      // Structured values remain provider-owned until JSON capture completes.
      // Mask both nested accessors and custom schema thenables from re-entering
      // the component domain while the Agent result boundary is active.
      validated = await ComponentEvaluationContext.withoutAccess(
        async () => await output.validate(structured),
      )
    } catch (cause) {
      throw new EvaluationError(
        `Agent "${input.provider.name}" (${input.trace.spanId}) returned invalid structured output`,
        { cause },
      )
    }

    return Object.freeze({ structured: validated, text })
  }
}
