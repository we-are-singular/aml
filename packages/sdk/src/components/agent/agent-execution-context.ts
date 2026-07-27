import type { AmlTraceIdentity } from "../../core/trace-identity.js"

/**
 * Evaluation-scoped dependencies supplied to one provider session.
 */
export interface AgentExecutionContext {
  readonly signal: AbortSignal
  readonly trace: AmlTraceIdentity
}
