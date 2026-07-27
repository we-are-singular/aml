import type { AmlTraceIdentity } from "../../core/trace-identity.js"
import type { AgentTool } from "../tool/agent-tool.js"

/**
 * Provider-neutral input for one Agent session.
 */
export interface AgentRequest {
  readonly model?: string
  readonly prompt: string
  readonly system: string
  readonly tools: readonly AgentTool[]
  readonly trace?: AmlTraceIdentity
}
