const AML_AGENT_TIMEOUT_ERROR = Symbol.for("@aml-jsx/sdk/agent-timeout-error")

/** Error used as the cancellation reason when an Agent execution expires. */
export class AgentTimeoutError extends Error {
  readonly timeoutMs: number

  constructor(timeoutMs: number) {
    super(`<Agent> execution timed out after ${timeoutMs}ms`)
    this.name = "AgentTimeoutError"
    this.timeoutMs = timeoutMs
    Object.defineProperty(this, AML_AGENT_TIMEOUT_ERROR, { value: true })
  }

  /** Recognizes timeout reasons created by another physical SDK copy. */
  static is(value: unknown): value is AgentTimeoutError {
    if (typeof value !== "object" || value === null) return false

    const timeout = value as Record<PropertyKey, unknown>
    const timeoutMs = timeout.timeoutMs
    return (
      timeout[AML_AGENT_TIMEOUT_ERROR] === true &&
      typeof timeoutMs === "number" &&
      Number.isSafeInteger(timeoutMs) &&
      timeoutMs > 0
    )
  }
}

/**
 * Links one Agent-local timeout to its enclosing evaluation cancellation.
 * The timeout is armed only after the Agent acquires a scheduler slot.
 */
export class AgentCancellationScope {
  readonly #controller = new AbortController()
  readonly #outerSignal: AbortSignal
  readonly #timeoutMs: number | undefined
  readonly #onOuterAbort: () => void
  #timer: ReturnType<typeof setTimeout> | undefined

  constructor(outerSignal: AbortSignal, timeoutMs: number | undefined) {
    this.#outerSignal = outerSignal
    this.#timeoutMs = timeoutMs
    this.#onOuterAbort = () => this.#controller.abort(outerSignal.reason)

    if (outerSignal.aborted) {
      this.#onOuterAbort()
    } else {
      outerSignal.addEventListener("abort", this.#onOuterAbort, { once: true })
    }
  }

  get signal(): AbortSignal {
    return this.#controller.signal
  }

  /** Starts the provider-execution timeout after scheduler admission. */
  start(): void {
    const timeoutMs = this.#timeoutMs

    if (timeoutMs === undefined || this.signal.aborted || this.#timer !== undefined) {
      return
    }

    this.#timer = setTimeout(() => {
      this.#timer = undefined
      this.#controller.abort(new AgentTimeoutError(timeoutMs))
    }, timeoutMs)
  }

  /** Releases the linked listener and timer on every terminal path. */
  dispose(): void {
    this.#outerSignal.removeEventListener("abort", this.#onOuterAbort)

    if (this.#timer !== undefined) {
      clearTimeout(this.#timer)
      this.#timer = undefined
    }
  }
}
