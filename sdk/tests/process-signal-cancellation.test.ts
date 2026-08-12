import { EventEmitter } from "node:events"
import { setTimeout as delay } from "node:timers/promises"

import { describe, expect, it, vi } from "vitest"

import {
  type ProcessSignal,
  ProcessSignalCancellation,
  type ProcessSignalCancellationOptions,
} from "../src/core/process-signal-cancellation.js"

class SignalHost extends EventEmitter {
  readonly exit = vi.fn((_code: number): never => undefined as never)

  override off(signal: ProcessSignal, listener: () => void): this {
    return super.off(signal, listener)
  }

  override on(signal: ProcessSignal, listener: () => void): this {
    return super.on(signal, listener)
  }
}

describe("ProcessSignalCancellation", () => {
  it.each([
    { exitCode: 130, signal: "SIGINT" as const },
    { exitCode: 143, signal: "SIGTERM" as const },
  ])("aborts once and reports the conventional $signal exit code", ({ exitCode, signal }) => {
    const host = new SignalHost()
    const cancellation = createCancellation(host)

    host.emit(signal)

    expect(cancellation.signal.aborted).toBe(true)
    expect(cancellation.signal.reason).toEqual(new Error(`AML evaluation interrupted by ${signal}`))
    expect(cancellation.exitCode).toBe(exitCode)
    expect(host.exit).not.toHaveBeenCalled()
    cancellation.dispose()
    expect(host.listenerCount("SIGINT")).toBe(0)
    expect(host.listenerCount("SIGTERM")).toBe(0)
  })

  it("forces termination when graceful cleanup exceeds its configured deadline", async () => {
    const host = new SignalHost()
    const cancellation = createCancellation(host, { cleanupDeadlineMs: 1 })

    host.emit("SIGTERM")
    await delay(10)

    expect(host.exit).toHaveBeenCalledWith(143)
    cancellation.dispose()
  })

  it("cancels the force-exit deadline when disposed after cancellation", async () => {
    const host = new SignalHost()
    const cancellation = createCancellation(host, { cleanupDeadlineMs: 1 })

    host.emit("SIGTERM")
    cancellation.dispose()
    await delay(10)

    expect(host.exit).not.toHaveBeenCalled()
  })

  it("forces termination immediately when a second signal arrives", () => {
    const host = new SignalHost()
    const cancellation = createCancellation(host)

    host.emit("SIGTERM")
    host.emit("SIGINT")

    expect(host.exit).toHaveBeenCalledWith(130)
    cancellation.dispose()
  })

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])("rejects invalid cleanup deadline %s", cleanupDeadlineMs => {
    expect(() => createCancellation(new SignalHost(), { cleanupDeadlineMs })).toThrow(
      new RangeError("Process signal cleanupDeadlineMs must be a non-negative safe integer")
    )
  })
})

function createCancellation(
  host: SignalHost,
  options: Readonly<ProcessSignalCancellationOptions> = {}
): ProcessSignalCancellation {
  // The production constructor deliberately exposes only application options;
  // this cast injects the process-shaped test host into its implementation.
  const TestCancellation = ProcessSignalCancellation as unknown as new (
    options: Readonly<ProcessSignalCancellationOptions>,
    host: SignalHost
  ) => ProcessSignalCancellation
  return new TestCancellation(options, host)
}
