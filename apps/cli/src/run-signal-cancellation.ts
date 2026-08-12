import process from "node:process"
import { clearTimeout, setTimeout } from "node:timers"

const DEFAULT_CLEANUP_DEADLINE_MS = 10_000

export type RunSignal = "SIGINT" | "SIGTERM"

interface SignalHost {
  exit(code: number): never
  off(signal: RunSignal, listener: () => void): this
  on(signal: RunSignal, listener: () => void): this
}

/** Owns process-signal cancellation and the bounded graceful-shutdown window for one CLI run. */
export class RunSignalCancellation {
  readonly #abortController = new globalThis.AbortController()
  #cleanupDeadline: ReturnType<typeof setTimeout> | undefined
  readonly #cleanupDeadlineMs: number
  readonly #host: SignalHost
  #receivedSignal: RunSignal | undefined

  constructor(host: SignalHost = process, cleanupDeadlineMs = DEFAULT_CLEANUP_DEADLINE_MS) {
    this.#host = host
    this.#cleanupDeadlineMs = cleanupDeadlineMs
    host.on("SIGINT", this.#onSigint)
    host.on("SIGTERM", this.#onSigterm)
  }

  get exitCode(): number | undefined {
    return this.#receivedSignal === undefined ? undefined : signalExitCode(this.#receivedSignal)
  }

  get signal(): AbortSignal {
    return this.#abortController.signal
  }

  dispose(): void {
    this.#host.off("SIGINT", this.#onSigint)
    this.#host.off("SIGTERM", this.#onSigterm)
    if (this.#cleanupDeadline !== undefined) clearTimeout(this.#cleanupDeadline)
  }

  readonly #onSigint = (): void => this.#abort("SIGINT")
  readonly #onSigterm = (): void => this.#abort("SIGTERM")

  #abort(signal: RunSignal): void {
    if (this.#receivedSignal !== undefined) {
      // A repeated interrupt is an explicit request to stop waiting for
      // provider cleanup and terminate with the latest signal's exit code.
      return this.#host.exit(signalExitCode(signal))
    }

    this.#receivedSignal = signal
    this.#abortController.abort(new Error(`aml run interrupted by ${signal}`))

    // Cleanup must remain bounded even when a provider cannot finish release.
    this.#cleanupDeadline = setTimeout(() => this.#host.exit(signalExitCode(signal)), this.#cleanupDeadlineMs)
  }
}

function signalExitCode(signal: RunSignal): number {
  return signal === "SIGINT" ? 130 : 143
}
