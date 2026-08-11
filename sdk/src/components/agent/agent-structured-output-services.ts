import type { AgentExecutionContext } from "./agent-execution-context.js"

const AML_AGENT_STRUCTURED_OUTPUT_SERVICES = Symbol.for("@aml-jsx/sdk/agent-structured-output-services")

interface AmlAgentStructuredOutputGlobal {
  [AML_AGENT_STRUCTURED_OUTPUT_SERVICES]?: WeakMap<object, Readonly<AgentStructuredOutputServices>>
}

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

const servicesRegistry = agentStructuredOutputServicesRegistry()

export function attachAgentStructuredOutputServices(
  context: AgentExecutionContext,
  services: Readonly<AgentStructuredOutputServices>
): void {
  servicesRegistry.set(context, Object.freeze(services))
}

export function agentStructuredOutputServices(context: AgentExecutionContext): Readonly<AgentStructuredOutputServices> {
  const services = servicesRegistry.get(context)

  if (services === undefined) {
    throw new Error("AML structured-output services are unavailable for this Agent invocation")
  }

  return services
}

/**
 * Shares invocation services across physical SDK copies in one JavaScript realm.
 */
function agentStructuredOutputServicesRegistry(): WeakMap<object, Readonly<AgentStructuredOutputServices>> {
  const amlGlobal = globalThis as typeof globalThis & AmlAgentStructuredOutputGlobal
  const existing = amlGlobal[AML_AGENT_STRUCTURED_OUTPUT_SERVICES]

  if (existing !== undefined) {
    if (!(existing instanceof WeakMap)) {
      throw new TypeError("AML Agent structured-output services registry has an invalid global value")
    }

    return existing
  }

  const created = new WeakMap<object, Readonly<AgentStructuredOutputServices>>()

  Object.defineProperty(amlGlobal, AML_AGENT_STRUCTURED_OUTPUT_SERVICES, {
    configurable: false,
    enumerable: false,
    value: created,
    writable: false,
  })

  return created
}
