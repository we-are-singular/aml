import type { AmlTraceIdentity } from "../../core/trace-identity.js"
import type { AgentMcpServer } from "../mcp/aml-mcp-server.js"
import type { AgentTool } from "../tool/agent-tool.js"
import type { AgentOutputRequest } from "./agent-output-request.js"
import type { AgentPermissions } from "./agent.js"

/**
 * Provider-neutral input for one Agent session.
 */
export interface AgentRequest {
  /**
   * Ordered later user inputs executed in the same provider session.
   */
  readonly followUps?: readonly string[]
  readonly mcpServers: readonly AgentMcpServer[]
  readonly model?: string
  /** Optional authored metadata used only for diagnostics and tracing. */
  readonly name?: string
  readonly output?: AgentOutputRequest
  readonly permissions: AgentPermissions
  readonly prompt: string
  readonly system: string
  readonly timeoutMs?: number
  readonly tools: readonly AgentTool[]
  readonly trace?: AmlTraceIdentity
}
