import type { AmlTraceIdentity } from "./trace-identity.js"
import { EvaluationError } from "./evaluation-error.js"

/**
 * Owns cancellation and correlation identity for one complete evaluation.
 */
export class EvaluationContext {
  readonly #maxAgentCalls: number
  readonly #runId = globalThis.crypto.randomUUID()
  readonly #signal: AbortSignal
  #agentCalls = 0
  #spanSequence = 0

  constructor(maxAgentCalls: number, signal: AbortSignal) {
    this.#maxAgentCalls = maxAgentCalls
    this.#signal = signal
  }

  get signal(): AbortSignal {
    return this.#signal
  }

  createTrace(parentSpanId?: string): AmlTraceIdentity {
    this.#spanSequence += 1

    return Object.freeze({
      ...(parentSpanId === undefined ? {} : { parentSpanId }),
      runId: this.#runId,
      spanId: `span-${this.#spanSequence}`,
    })
  }

  reserveAgentCall(trace: AmlTraceIdentity): void {
    if (
      this.#maxAgentCalls !== 0 &&
      this.#agentCalls >= this.#maxAgentCalls
    ) {
      throw new EvaluationError(
        `AML evaluation exceeded maxAgentCalls ${this.#maxAgentCalls} at Agent ${trace.spanId}`,
      )
    }

    this.#agentCalls += 1
  }
}
