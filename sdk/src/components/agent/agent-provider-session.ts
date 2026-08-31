import type { AgentExecutionContext } from "./agent-execution-context.js"
import type { AgentOutputRequest } from "./agent-output-request.js"
import type { AgentResponse } from "./agent-response.js"

/**
 * One ordered authored input translated by a provider-owned session.
 */
export interface AgentProviderTurn {
  /** Zero-based authored turn index; `0` is the initial prompt. */
  readonly index: number

  /** Whether this is the last authored turn in the retained conversation. */
  readonly isFinal: boolean

  /**
   * Structured-output request attached only to the final authored turn.
   *
   * Omitted for text Agents and for every non-final follow-up turn.
   */
  readonly output?: AgentOutputRequest

  /** Non-empty provider input for this turn, already trimmed by AML. */
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
   *
   * AML calls this at most once, awaits it before `close`, and preserves the
   * caller's abort reason if this method fails.
   */
  abort?(): Promise<void>

  /**
   * Releases every invocation-owned provider resource.
   *
   * AML invokes this exactly once after session validation and after all started
   * turn or abort work settles. Implementations should be safe after partial
   * session initialization.
   */
  close(): Promise<void>

  /**
   * Executes one authored turn in the retained provider conversation.
   *
   * Calls are serial and preserve `turn.index`. The returned response belongs
   * to this turn; AML returns only the final turn response to the workflow.
   */
  runTurn(turn: Readonly<AgentProviderTurn>, context: AgentExecutionContext): Promise<AgentResponse>
}
