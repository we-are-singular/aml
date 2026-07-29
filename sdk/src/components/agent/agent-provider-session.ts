import type { AgentExecutionContext } from "./agent-execution-context.js"
import type { AgentOutputRequest } from "./agent-output-request.js"
import type { AgentResponse } from "./agent-response.js"

/**
 * One ordered authored input translated by a provider-owned session.
 */
export interface AgentProviderTurn {
  readonly index: number
  readonly isFinal: boolean
  readonly output?: AgentOutputRequest
  readonly prompt: string
}

/**
 * Invocation-scoped provider session consumed by `AbstractAgentProvider`.
 *
 * Capability attachment belongs to session creation. `close()` must release
 * every invocation-owned capability and provider resource.
 */
export interface AgentProviderSession {
  /**
   * Requests provider-native cancellation when the active operation cannot
   * rely on `AgentExecutionContext.signal` alone.
   */
  abort?(): Promise<void>

  /**
   * Releases every invocation-owned provider resource.
   */
  close(): Promise<void>

  /**
   * Executes one authored turn in the retained provider conversation.
   */
  runTurn(turn: Readonly<AgentProviderTurn>, context: AgentExecutionContext): Promise<AgentResponse>
}
