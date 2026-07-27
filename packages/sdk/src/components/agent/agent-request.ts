import type { AmlTraceIdentity } from "../../core/trace-identity.js"

/**
 * Provider-neutral input for one Agent session.
 */
export interface AgentRequest {
  readonly model?: string
  readonly prompt: string
  readonly system: string
  readonly trace?: AmlTraceIdentity
}
