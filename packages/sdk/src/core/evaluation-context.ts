import type { AmlTraceIdentity } from "./trace-identity.js"
import { AgentScheduler } from "./agent-scheduler.js"
import { EvaluationError } from "./evaluation-error.js"

/**
 * Owns cancellation and correlation identity for one complete evaluation.
 */
export class EvaluationContext {
  readonly #agentScheduler: AgentScheduler
  readonly #maxAgentCalls: number
  readonly #maxStateTransitions: number
  readonly #runId = globalThis.crypto.randomUUID()
  readonly #signal: AbortSignal
  #agentCalls = 0
  #spanSequence = 0
  #stateTransitions = 0

  /**
   * Creates evaluation-owned counters around the caller's cancellation signal.
   */
  constructor(
    maxAgentCalls: number,
    maxConcurrentAgents: number,
    maxStateTransitions: number,
    signal: AbortSignal,
  ) {
    this.#agentScheduler = new AgentScheduler(
      maxConcurrentAgents,
      signal,
    )
    this.#maxAgentCalls = maxAgentCalls
    this.#maxStateTransitions = maxStateTransitions
    this.#signal = signal
  }

  /**
   * Exposes the one cancellation boundary shared by every nested operation.
   */
  get signal(): AbortSignal {
    return this.#signal
  }

  /**
   * Allocates a stable parent-aware identity for one Agent invocation.
   */
  createTrace(parentSpanId?: string): AmlTraceIdentity {
    this.#spanSequence += 1

    return Object.freeze({
      ...(parentSpanId === undefined ? {} : { parentSpanId }),
      runId: this.#runId,
      spanId: `span-${this.#spanSequence}`,
    })
  }

  /**
   * Reserves one provider call before it enters the scheduler.
   */
  reserveAgentCall(trace: AmlTraceIdentity): void {
    this.#signal.throwIfAborted()

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

  /**
   * Reserves one complete Loop commit across the evaluation domain.
   */
  reserveStateTransition(name: string, iteration: number): void {
    this.#signal.throwIfAborted()

    if (
      this.#maxStateTransitions !== 0 &&
      this.#stateTransitions >= this.#maxStateTransitions
    ) {
      throw new EvaluationError(
        `AML evaluation exceeded maxStateTransitions ${this.#maxStateTransitions} at Loop "${name}" iteration ${iteration}`,
      )
    }

    this.#stateTransitions += 1
  }

  /**
   * Schedules one reserved provider call in this domain.
   */
  async scheduleAgent<Result>(
    operation: () => PromiseLike<Result> | Result,
  ): Promise<Result> {
    return await this.#agentScheduler.run(operation)
  }

  /**
   * Releases scheduler listeners after every nested evaluation has settled.
   */
  close(): void {
    this.#agentScheduler.close()
  }
}
