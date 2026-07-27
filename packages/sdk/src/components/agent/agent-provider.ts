import type { AgentExecutionContext } from "./agent-execution-context.js"
import type { AgentRequest } from "./agent-request.js"
import type { AgentResponse } from "./agent-response.js"

/**
 * Executes one fully assembled Agent request through a configured harness.
 */
export interface AgentProvider {
  readonly name: string
  run(
    request: AgentRequest,
    context: AgentExecutionContext,
  ): Promise<AgentResponse>
}
