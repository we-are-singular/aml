import { ComponentEvaluationContext } from "../../core/component-evaluation-context.js"
import type { EvaluationContext } from "../../core/evaluation-context.js"
import { EvaluationError } from "../../core/evaluation-error.js"
import type { AmlTraceIdentity } from "../../core/trace-identity.js"
import type { SandboxSession } from "../sandbox/sandbox-provider.js"
import type { AgentMcpServer } from "../mcp/aml-mcp-server.js"
import type { AgentSkill } from "../skill/agent-skill.js"
import type { AgentTool } from "../tool/agent-tool.js"
import { agentDiagnosticIdentity } from "./agent-diagnostic-identity.js"
import { AgentExecutionResult } from "./agent-execution-result.js"
import { ModelSchema } from "./model-schema.js"
import type { AgentProps } from "./agent.js"
import type { AgentProvider } from "./agent-provider.js"
import { AgentRequestPlan } from "./agent-request-plan.js"
import { AgentCancellationScope } from "./agent-timeout.js"
import type { AgentResponse } from "./agent-response.js"
import { type ValidatedAgentProvider, validateAgentProvider } from "./validate-agent-provider.js"

/**
 * Coordinates Agent validation, provider execution, and response resolution.
 */
export class AgentExecutor {
  readonly #agentProvider: Readonly<ValidatedAgentProvider> | undefined
  readonly #maxTurnsPerAgent: number
  readonly #system: string
  readonly #toolPrefix: string

  /**
   * Captures runtime-wide Agent defaults and their provider boundary.
   */
  constructor(options: {
    readonly agentProvider?: AgentProvider
    readonly maxTurnsPerAgent: number
    readonly system?: string
    readonly toolPrefix?: string
  }) {
    if (options.system !== undefined && typeof options.system !== "string") {
      throw new TypeError("system must be a string")
    }

    if (
      options.toolPrefix !== undefined &&
      (typeof options.toolPrefix !== "string" ||
        (options.toolPrefix.length > 0 && options.toolPrefix !== options.toolPrefix.trim()))
    ) {
      throw new TypeError("toolPrefix must be an empty or non-empty normalized string")
    }

    this.#agentProvider = options.agentProvider === undefined ? undefined : validateAgentProvider(options.agentProvider)
    this.#maxTurnsPerAgent = options.maxTurnsPerAgent
    this.#system = options.system ?? ""
    this.#toolPrefix = options.toolPrefix || "aml"
  }

  /**
   * Validates portable Agent props before any descendants execute.
   */
  validateProps(props: Readonly<AgentProps>): Readonly<ValidatedAgentProvider> | undefined {
    if (props.model !== undefined && typeof props.model !== "string") {
      throw new EvaluationError("<Agent> model must be a string")
    }

    if (
      props.name !== undefined &&
      (typeof props.name !== "string" || props.name.length === 0 || props.name !== props.name.trim())
    ) {
      throw new EvaluationError("<Agent> name must be a non-empty normalized string")
    }

    if (props.system !== undefined && typeof props.system !== "string") {
      throw new EvaluationError("<Agent> system must be a string")
    }

    if (props.timeoutMs !== undefined && (!Number.isSafeInteger(props.timeoutMs) || props.timeoutMs <= 0)) {
      throw new EvaluationError("<Agent> timeoutMs must be a positive safe integer")
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
   * Selects one schema owner for an Agent before its descendants execute.
   */
  outputSchema(
    props: Readonly<AgentProps>,
    evaluationSchema: ModelSchema<unknown> | undefined
  ): ModelSchema<unknown> | undefined {
    if (props.schema !== undefined && evaluationSchema !== undefined) {
      throw new EvaluationError("<Agent> schema cannot be combined with evaluate(value, schema)")
    }

    return props.schema === undefined ? evaluationSchema : new ModelSchema(props.schema)
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
    readonly skills: readonly AgentSkill[]
    readonly systemFragments: readonly string[]
    readonly tools: readonly AgentTool[]
    readonly trace: AmlTraceIdentity
  }): Promise<Readonly<AgentExecutionResult>> {
    const identity = agentDiagnosticIdentity({
      name: input.props.name,
      ...(input.provider === undefined ? {} : { provider: input.provider.name }),
      spanId: input.trace.spanId,
    })

    if (!input.provider) {
      throw new EvaluationError(`${identity} has no provider`)
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
        const message =
          input.props.name === undefined
            ? `Agent provider "${input.provider.name}" failed its Sandbox compatibility check`
            : `${identity} failed its Sandbox compatibility check`
        throw new EvaluationError(message, {
          cause,
        })
      }

      if (!supported) {
        const message =
          input.props.name === undefined
            ? `Agent provider "${input.provider.name}" cannot run inside Sandbox provider "${input.sandbox.provider.name}"`
            : `${identity} cannot run inside Sandbox provider "${input.sandbox.provider.name}"`
        throw new EvaluationError(message)
      }
    }

    const cancellationScope = new AgentCancellationScope(input.context.signal, input.props.timeoutMs)
    let providerStarted = false
    let plan: AgentRequestPlan
    let response: AgentResponse

    try {
      plan = AgentRequestPlan.create({
        context: input.context,
        followUps: input.followUps,
        maxTurns: this.#maxTurnsPerAgent,
        mcpServers: input.mcpServers,
        output: input.output,
        prompt: input.prompt,
        props: input.props,
        runtimeSystem: this.#system,
        sandbox: input.sandbox,
        signal: cancellationScope.signal,
        skillDiscovery: provider.skillDiscovery,
        skills: input.skills,
        systemFragments: input.systemFragments,
        tools: input.tools,
        toolPrefix: this.#toolPrefix,
        trace: input.trace,
      })
    } catch (cause) {
      cancellationScope.dispose()
      throw cause
    }

    // Reserve only after the complete plan exists. Limit errors belong to AML,
    // not the provider failure boundary below.
    try {
      input.context.reserveAgentCall(input.trace, input.props.name)
    } catch (cause) {
      cancellationScope.dispose()
      throw cause
    }

    try {
      // Scheduling begins only after the complete Agent plan exists. The slot
      // covers provider-owned session and capability cleanup because run()
      // cannot settle until the adapter has finished that lifecycle.
      response = await input.context.scheduleAgent(() => {
        providerStarted = true
        cancellationScope.start()

        // The async wrapper is created inside exit(), so Promise/thenable
        // assimilation and every provider-created continuation remain masked.
        return ComponentEvaluationContext.withoutAccess(
          async () => await Reflect.apply(provider.run, provider.provider, [plan.request, plan.context])
        )
      })
    } catch (cause) {
      if (!providerStarted && input.context.signal.aborted) {
        throw new EvaluationError(`${identity} was cancelled before provider execution`, { cause })
      }

      throw new EvaluationError(`${identity} failed`, { cause })
    } finally {
      cancellationScope.dispose()
    }

    return await AgentExecutionResult.from({
      mcpServers: input.mcpServers.length,
      model: plan.request.model,
      name: plan.request.name,
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
