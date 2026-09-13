import type { StopReason } from "@agentclientprotocol/sdk"

/** Output observed during one ACP prompt, including an incomplete failed prompt. */
export interface AcpAgentAttempt {
  /** Assistant messages when the adapter supplied boundaries for every text chunk. */
  readonly messages?: readonly string[]

  /** Provider-reported completion reason; omitted when the prompt failed before completion. */
  readonly stopReason?: StopReason

  /** Concatenated assistant text received for this prompt; never treated as validated output. */
  readonly text: string
}

/** Session diagnostics accompanying an ACP invocation failure. */
export interface AcpAgentErrorOptions extends ErrorOptions {
  /** Authored prompt followed by its repair, if attempted; excludes prompt instructions. */
  readonly attempts: readonly AcpAgentAttempt[]

  /** ACP session that produced these attempts. */
  readonly sessionId: string
}

/**
 * Preserves ACP output when prompting or structured submission fails.
 *
 * The enclosing EvaluationError identifies the authored Agent. Its cause is
 * this error, whose cause retains the original protocol or submission failure.
 * Attempt text may be sensitive and is not added to metadata-only traces.
 */
export class AcpAgentError extends Error {
  /** Immutable prompt attempts in execution order, including any failed partial response. */
  readonly attempts: readonly AcpAgentAttempt[]

  /** ACP session identifier retained after invocation cleanup. */
  readonly sessionId: string

  /** Copies diagnostics before provider-owned session resources are released. */
  constructor(message: string, options: AcpAgentErrorOptions) {
    super(message, { cause: options.cause })
    this.name = "AcpAgentError"
    this.sessionId = options.sessionId
    this.attempts = Object.freeze(
      options.attempts.map(attempt =>
        Object.freeze({
          ...attempt,
          ...(attempt.messages === undefined ? {} : { messages: Object.freeze([...attempt.messages]) }),
        })
      )
    )
  }
}
