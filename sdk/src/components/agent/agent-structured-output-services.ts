import type { AgentExecutionContext } from "./agent-execution-context.js"

export type AgentOutputSubmissionStatus = "accepted" | "ignored" | "invalid"

/**
 * Runtime-owned services used by the built-in structured-output adapter.
 * They stay outside the public provider context so providers cannot publish
 * arbitrary AML trace events or invoke application schemas directly.
 */
export interface AgentStructuredOutputServices {
  traceSubmission(call: number, status: AgentOutputSubmissionStatus): void
  validate(value: unknown): Promise<void>
}

const SERVICES = new WeakMap<AgentExecutionContext, Readonly<AgentStructuredOutputServices>>()

export function attachAgentStructuredOutputServices(
  context: AgentExecutionContext,
  services: Readonly<AgentStructuredOutputServices>
): void {
  SERVICES.set(context, Object.freeze(services))
}

export function agentStructuredOutputServices(context: AgentExecutionContext): Readonly<AgentStructuredOutputServices> {
  const services = SERVICES.get(context)

  if (services === undefined) {
    throw new Error("AML structured-output services are unavailable for this Agent invocation")
  }

  return services
}
