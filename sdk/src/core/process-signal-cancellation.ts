import process from "node:process"
import { clearTimeout, setTimeout } from "node:timers"

const DEFAULT_CLEANUP_DEADLINE_MS = 10_000

/** Process interrupts handled by {@link ProcessSignalCancellation}. */
export type ProcessSignal = "SIGINT" | "SIGTERM"

/** Construction options for {@link ProcessSignalCancellation}. */
export interface ProcessSignalCancellationOptions {
  /**
   * Maximum time allowed for cancellation-aware cleanup before the process is
   * forcibly terminated with the signal's conventional exit code.
   *
   * Defaults to `10_000` milliseconds. Use `0` to schedule forced termination
   * immediately after the abort is dispatched. The value must be a
   * non-negative safe integer.
   */
  readonly cleanupDeadlineMs?: number
}

interface ProcessSignalHost {
  exit(code: number): never
  off(signal: ProcessSignal, listener: () => void): this
  on(signal: ProcessSignal, listener: () => void): this
}

/**
 * Converts process interruption into one caller-owned cancellation signal.
 *
 * Construction explicitly installs SIGINT and SIGTERM listeners. Dispose the
 * instance after every evaluation has settled so listeners and its force-exit
 * deadline cannot outlive the application shutdown boundary.
 */
export class ProcessSignalCancellation {
  readonly #abortController = new globalThis.AbortController()
  #cleanupDeadline: ReturnType<typeof setTimeout> | undefined
  readonly #cleanupDeadlineMs: number
  readonly #host: ProcessSignalHost
  #receivedSignal: ProcessSignal | undefined

  /**
   * Installs `SIGINT` and `SIGTERM` listeners on the current Node.js process.
   *
   * Each instance must be disposed after the associated evaluation and cleanup
   * finish. Construction throws for an invalid cleanup deadline.
   */
  constructor(options?: Readonly<ProcessSignalCancellationOptions>)
  constructor(options: Readonly<ProcessSignalCancellationOptions> = {}, host: ProcessSignalHost = process) {
    if (
      options.cleanupDeadlineMs !== undefined &&
      (!Number.isSafeInteger(options.cleanupDeadlineMs) || options.cleanupDeadlineMs < 0)
    ) {
      throw new RangeError("Process signal cleanupDeadlineMs must be a non-negative safe integer")
    }

    this.#host = host
    this.#cleanupDeadlineMs = options.cleanupDeadlineMs ?? DEFAULT_CLEANUP_DEADLINE_MS
    host.on("SIGINT", this.#onSigint)
    host.on("SIGTERM", this.#onSigterm)
  }

  /**
   * Conventional process exit code for the first received signal.
   *
   * Returns `undefined` until interrupted, `130` for `SIGINT`, and `143` for
   * `SIGTERM`. Applications can assign this value to `process.exitCode` after
   * graceful cleanup.
   */
  get exitCode(): number | undefined {
    return this.#receivedSignal === undefined ? undefined : signalExitCode(this.#receivedSignal)
  }

  /**
   * Signal aborted when the process first receives `SIGINT` or `SIGTERM`.
   *
   * Its reason is an Error naming the received process signal.
   */
  get signal(): AbortSignal {
    return this.#abortController.signal
  }

  /**
   * Removes installed process listeners and cancels a pending forced-exit timer.
   *
   * Disposing does not reset or replace the exposed AbortSignal.
   */
  dispose(): void {
    this.#host.off("SIGINT", this.#onSigint)
    this.#host.off("SIGTERM", this.#onSigterm)
    if (this.#cleanupDeadline !== undefined) clearTimeout(this.#cleanupDeadline)
  }

  readonly #onSigint = (): void => this.#abort("SIGINT")
  readonly #onSigterm = (): void => this.#abort("SIGTERM")

  #abort(signal: ProcessSignal): void {
    if (this.#receivedSignal !== undefined) {
      // A repeated interrupt is an explicit request to stop waiting for
      // provider cleanup and terminate with the latest signal's exit code.
      return this.#host.exit(signalExitCode(signal))
    }

    this.#receivedSignal = signal
    this.#abortController.abort(new Error(`AML evaluation interrupted by ${signal}`))

    // Cleanup remains bounded because installing a Node signal listener removes
    // its default exit behavior. Applications may tune this deployment deadline.
    this.#cleanupDeadline = setTimeout(() => this.#host.exit(signalExitCode(signal)), this.#cleanupDeadlineMs)
  }
}

function signalExitCode(signal: ProcessSignal): number {
  return signal === "SIGINT" ? 130 : 143
}
