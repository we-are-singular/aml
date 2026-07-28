import pLimit, { type LimitFunction } from "p-limit"

import { EvaluationError } from "./evaluation-error.js"

/**
 * Bounds provider calls inside one evaluation domain.
 *
 * Authored tree resolution happens outside this owner. Only the complete
 * provider call occupies a slot, so nested post-order work cannot deadlock by
 * waiting for a parent Agent that already holds the shared limit.
 */
export class AgentScheduler {
  readonly #limit: LimitFunction
  readonly #onAbort: () => void
  readonly #signal: AbortSignal
  #closed = false

  /**
   * Creates one FIFO limiter and binds queued-work cancellation to the domain.
   */
  constructor(maxConcurrentAgents: number, signal: AbortSignal) {
    this.#limit = pLimit({
      concurrency: maxConcurrentAgents === 0 ? Number.POSITIVE_INFINITY : maxConcurrentAgents,
      // Cleared p-limit tasks otherwise remain pending forever. The scheduler
      // translates this internal AbortError back to the caller's exact reason.
      rejectOnClear: true,
    })
    this.#signal = signal
    this.#onAbort = () => {
      this.#limit.clearQueue()
    }
    signal.addEventListener("abort", this.#onAbort, { once: true })
  }

  /**
   * Runs one provider call when a domain slot becomes available.
   */
  async run<Result>(operation: () => PromiseLike<Result> | Result): Promise<Result> {
    if (this.#closed) {
      throw new EvaluationError("AML Agent scheduler is closed")
    }

    this.#signal.throwIfAborted()

    try {
      return await this.#limit(async () => {
        // Cancellation may happen while this call waits in p-limit's queue.
        // Recheck before application/provider code can observe any side effect.
        this.#signal.throwIfAborted()
        return await operation()
      })
    } catch (error) {
      if (this.#signal.aborted && error instanceof DOMException && error.name === "AbortError") {
        this.#signal.throwIfAborted()
      }

      throw error
    }
  }

  /**
   * Detaches cancellation state after the complete evaluation settles.
   */
  close(): void {
    if (this.#closed) {
      return
    }

    this.#closed = true
    this.#signal.removeEventListener("abort", this.#onAbort)
    // A correctly joined evaluation has no queued calls here. Clearing is a
    // defensive ownership boundary for future orchestration primitives.
    this.#limit.clearQueue()
  }
}
