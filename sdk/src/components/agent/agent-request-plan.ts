import type { EvaluationContext } from "../../core/evaluation-context.js"
import { EvaluationError } from "../../core/evaluation-error.js"
import type { AmlTraceIdentity } from "../../core/trace-identity.js"
import type { AgentMcpServer } from "../mcp/aml-mcp-server.js"
import type { SandboxSession } from "../sandbox/sandbox-provider.js"
import type { AgentSkill } from "../skill/agent-skill.js"
import type { AgentTool } from "../tool/agent-tool.js"
import { instrumentAgentTools } from "../tool/instrument-agent-tools.js"
import type { AgentProps } from "./agent.js"
import type { AgentExecutionContext } from "./agent-execution-context.js"
import { agentDiagnosticIdentity } from "./agent-diagnostic-identity.js"
import { attachAgentObservabilityServices, agentObservabilityServices } from "./agent-observability-services.js"
import { attachAgentStructuredOutputServices } from "./agent-structured-output-services.js"
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
    readonly signal?: AbortSignal
    readonly skillDiscovery: "native" | undefined
    readonly skills: readonly AgentSkill[]
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

    if (input.skillDiscovery !== "native" && input.skills.length > 0) {
      systemFragments.push(skillFallback(input.skills))
    }

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
      const identity = agentDiagnosticIdentity({ name: input.props.name, spanId: input.trace.spanId })
      throw new EvaluationError(`${identity} exceeded maxTurnsPerAgent ${input.maxTurns}`)
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
      ...(input.props.name === undefined ? {} : { name: input.props.name }),
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
      skills: input.skills,
      system: systemFragments.join("\n"),
      ...(input.props.timeoutMs === undefined ? {} : { timeoutMs: input.props.timeoutMs }),
      tools,
      trace: input.trace,
    })
    const context: AgentExecutionContext = Object.freeze({
      events: input.context.events,
      ...(input.sandbox === undefined ? {} : { sandbox: input.sandbox }),
      signal: input.signal ?? input.context.signal,
      trace: input.trace,
    })
    attachAgentObservabilityServices(context, input.context)

    if (input.output !== undefined) {
      attachAgentStructuredOutputServices(context, {
        traceSubmission: (call, status, value) => {
          const observability = agentObservabilityServices(context)

          // Structured output can contain the complete model result. Do not
          // even serialize it until a listener explicitly accepts content.
          observability.event(
            observability.currentTrace(),
            "agent.output",
            { call, status },
            value === undefined ? {} : observability.sensitiveAttribute("output", value)
          )
        },
        validate: async value => {
          await input.output?.validate(value)
        },
      })
    }

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

    for (const skill of input.skills) {
      input.context.traceEvent(input.trace, "capability.skill", {
        name: skill.name,
        native: input.skillDiscovery === "native",
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

function skillFallback(skills: readonly AgentSkill[]): string {
  return skills
    .map(skill => {
      const description = /[.!?]$/.test(skill.description) ? skill.description : `${skill.description}.`
      return [
        `## Available skill: \`${skill.name}\``,
        `Use when: ${description}`,
        `Read \`${skill.skillFile}\` when this skill applies.`,
      ].join("\n")
    })
    .join("\n\n")
}
