import type { EvaluationContext } from "../../core/evaluation-context.js"
import { EvaluationError } from "../../core/evaluation-error.js"
import type { AmlTraceIdentity } from "../../core/trace-identity.js"
import type { AgentMcpServer } from "../mcp/aml-mcp-server.js"
import type { SandboxSession } from "../sandbox/sandbox-provider.js"
import type { AgentTool } from "../tool/agent-tool.js"
import { instrumentAgentTools } from "../tool/instrument-agent-tools.js"
import type { AgentProps } from "./agent.js"
import type { AgentExecutionContext } from "./agent-execution-context.js"
import type { ModelSchema } from "./model-schema.js"
import type { AgentRequest } from "./agent-request.js"

/**
 * Immutable provider handoff assembled from one resolved `<Agent>` tree.
 */
export class AgentRequestPlan {
  readonly context: AgentExecutionContext
  readonly followUps: readonly string[]
  readonly prompt: string
  readonly request: AgentRequest
  readonly tools: readonly AgentTool[]
  readonly turnCount: number

  private constructor(input: {
    readonly context: AgentExecutionContext
    readonly followUps: readonly string[]
    readonly prompt: string
    readonly request: AgentRequest
    readonly tools: readonly AgentTool[]
  }) {
    this.context = input.context
    this.followUps = input.followUps
    this.prompt = input.prompt
    this.request = input.request
    this.tools = input.tools
    this.turnCount = 1 + input.followUps.length
    Object.freeze(this)
  }

  /**
   * Normalizes authored turns, capabilities, and system fragments once.
   */
  static create(input: {
    readonly context: EvaluationContext
    readonly followUps: readonly string[]
    readonly maxTurns: number
    readonly mcpServers: readonly AgentMcpServer[]
    readonly output: ModelSchema<unknown> | undefined
    readonly prompt: string
    readonly props: Readonly<AgentProps>
    readonly runtimeSystem: string
    readonly sandbox: Readonly<SandboxSession> | undefined
    readonly systemFragments: readonly string[]
    readonly tools: readonly AgentTool[]
    readonly trace: AmlTraceIdentity
  }): AgentRequestPlan {
    const systemFragments: string[] = []

    // Runtime and Agent system text precede resolved <System> descendants.
    for (const fixedSystem of [input.runtimeSystem, input.props.system]) {
      const text = fixedSystem?.trim()

      if (text) {
        systemFragments.push(text)
      }
    }

    systemFragments.push(...input.systemFragments)

    const prompt = input.prompt.trim()
    const followUps = input.followUps.map(followUp => {
      const text = followUp.trim()

      if (text.length === 0) {
        throw new EvaluationError("<FollowUp> must resolve to non-empty text")
      }

      return text
    })
    const turnCount = 1 + followUps.length

    if (input.maxTurns !== 0 && turnCount > input.maxTurns) {
      throw new EvaluationError(`Agent ${input.trace.spanId} exceeded maxTurnsPerAgent ${input.maxTurns}`)
    }

    const tools = instrumentAgentTools(input.tools, input.context, input.trace)
    const permissions = Object.freeze({
      filesystem:
        input.sandbox?.access === "read-only" ? "read-only" : (input.props.permissions?.filesystem ?? "read-write"),
      network: input.props.permissions?.network ?? true,
      shell: input.props.permissions?.shell ?? true,
    })
    const request: AgentRequest = Object.freeze({
      ...(followUps.length === 0 ? {} : { followUps: Object.freeze(followUps) }),
      ...(input.props.model === undefined ? {} : { model: input.props.model }),
      mcpServers: input.mcpServers,
      ...(input.output === undefined
        ? {}
        : {
            output: Object.freeze({
              jsonSchema: input.output.jsonSchema,
              type: "json" as const,
            }),
          }),
      permissions,
      prompt,
      system: systemFragments.join("\n"),
      tools,
      trace: input.trace,
    })
    const context: AgentExecutionContext = Object.freeze({
      events: input.context.events,
      ...(input.sandbox === undefined ? {} : { sandbox: input.sandbox }),
      signal: input.context.signal,
      trace: input.trace,
    })

    // Capability grants are observable at the portable runtime boundary.
    for (const tool of tools) {
      input.context.traceEvent(input.trace, "capability.tool", {
        kind: tool.kind,
        name: tool.name,
      })
    }

    for (const server of input.mcpServers) {
      input.context.traceEvent(input.trace, "capability.mcp", {
        kind: server.kind === "named" ? "named" : server.definition.transport.type,
        name: server.kind === "named" ? server.name : server.definition.name,
      })
    }

    return new AgentRequestPlan({
      context,
      followUps: Object.freeze(followUps),
      prompt,
      request,
      tools,
    })
  }
}
