import type { AmlEventSubscriber } from "../../core/aml-event-subscriber.js"
import type { AmlTraceIdentity } from "../../core/trace-identity.js"
import type { SandboxSession } from "../sandbox/sandbox-provider.js"

/**
 * Evaluation-scoped dependencies supplied to one provider session.
 */
export interface AgentExecutionContext {
  readonly events: AmlEventSubscriber
  readonly sandbox?: SandboxSession
  readonly signal: AbortSignal
  readonly trace: AmlTraceIdentity
}
