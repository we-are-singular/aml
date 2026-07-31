import { ComponentEvaluationContext } from "../../core/component-evaluation-context.js"
import type { EvaluationContext } from "../../core/evaluation-context.js"
import { EvaluationError } from "../../core/evaluation-error.js"
import type { AmlTraceIdentity } from "../../core/trace-identity.js"
import type { SandboxSession } from "../sandbox/sandbox-provider.js"
import type { AgentMcpServer } from "../mcp/aml-mcp-server.js"
import type { AgentTool } from "../tool/agent-tool.js"
import { AgentExecutionResult } from "./agent-execution-result.js"
import type { ModelSchema } from "./model-schema.js"
import type { AgentProps } from "./agent.js"
import type { AgentProvider } from "./agent-provider.js"
import { AgentRequestPlan } from "./agent-request-plan.js"
import type { AgentResponse } from "./agent-response.js"
import { type ValidatedAgentProvider, validateAgentProvider } from "./validate-agent-provider.js"

/**
 * Coordinates Agent validation, provider execution, and response resolution.
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

    this.#agentProvider = options.agentProvider === undefined ? undefined : validateAgentProvider(options.agentProvider)
    this.#maxTurnsPerAgent = options.maxTurnsPerAgent
    this.#system = options.system ?? ""
  }

  /**
   * Validates portable Agent props before any descendants execute.
   */
  validateProps(props: Readonly<AgentProps>): Readonly<ValidatedAgentProvider> | undefined {
    if (props.model !== undefined && typeof props.model !== "string") {
      throw new EvaluationError("<Agent> model must be a string")
    }

    if (props.system !== undefined && typeof props.system !== "string") {
      throw new EvaluationError("<Agent> system must be a string")
    }

    if (props.permissions !== undefined) {
      if (typeof props.permissions !== "object" || props.permissions === null || Array.isArray(props.permissions)) {
        throw new EvaluationError("<Agent> permissions must be an object")
      }

      if (
        props.permissions.filesystem !== undefined &&
        props.permissions.filesystem !== "read-only" &&
        props.permissions.filesystem !== "read-write"
      ) {
        throw new EvaluationError('<Agent> permissions.filesystem must be "read-only" or "read-write"')
      }

      for (const name of ["network", "shell"] as const) {
        if (props.permissions[name] !== undefined && typeof props.permissions[name] !== "boolean") {
          throw new EvaluationError(`<Agent> permissions.${name} must be a boolean`)
        }
      }
    }

    const explicitProvider = props.provider

    return explicitProvider === undefined
      ? this.#agentProvider
      : ComponentEvaluationContext.withoutAccess(() => validateAgentProvider(explicitProvider))
  }

  /**
   * Runs one fully resolved Agent through its provider boundary.
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
    readonly tools: readonly AgentTool[]
    readonly trace: AmlTraceIdentity
  }): Promise<Readonly<AgentExecutionResult>> {
    if (!input.provider) {
      throw new EvaluationError(`Agent ${input.trace.spanId} has no provider`)
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
            Reflect.apply(supportsSandbox, provider.provider, [input.sandbox])
          ) === true
      } catch (cause) {
        throw new EvaluationError(`Agent provider "${input.provider.name}" failed its Sandbox compatibility check`, {
          cause,
        })
      }

      if (!supported) {
        throw new EvaluationError(
          `Agent provider "${input.provider.name}" cannot run inside Sandbox provider "${input.sandbox.provider.name}"`
        )
      }
    }

    const plan = AgentRequestPlan.create({
      context: input.context,
      followUps: input.followUps,
      maxTurns: this.#maxTurnsPerAgent,
      mcpServers: input.mcpServers,
      output: input.output,
      prompt: input.prompt,
      props: input.props,
      runtimeSystem: this.#system,
      sandbox: input.sandbox,
      systemFragments: input.systemFragments,
      tools: input.tools,
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
      response = await input.context.scheduleAgent(() => {
        providerStarted = true

        // AML cannot observe provider-internal per-turn timing, so publish
        // the complete authored order at the exact provider handoff.
        for (const [index, turn] of [plan.prompt, ...plan.followUps].entries()) {
          input.context.traceEvent(
            input.trace,
            "agent.turn",
            {
              index: index + 1,
              kind: index === 0 ? "initial" : "follow-up",
            },
            { content: turn }
          )
        }

        // The async wrapper is created inside exit(), so Promise/thenable
        // assimilation and every provider-created continuation remain masked.
        return ComponentEvaluationContext.withoutAccess(
          async () => await Reflect.apply(provider.run, provider.provider, [plan.request, plan.context])
        )
      })
    } catch (cause) {
      if (!providerStarted && input.context.signal.aborted) {
        throw new EvaluationError(
          `Agent "${provider.name}" (${input.trace.spanId}) was cancelled before provider execution`,
          { cause }
        )
      }

      throw new EvaluationError(`Agent "${provider.name}" (${input.trace.spanId}) failed`, { cause })
    }

    return await AgentExecutionResult.from({
      mcpServers: input.mcpServers.length,
      model: plan.request.model,
      output: input.output,
      prompt: plan.prompt,
      provider,
      response,
      spanId: input.trace.spanId,
      system: plan.request.system,
      tools: plan.tools.length,
      turns: plan.turnCount,
    })
  }
}
