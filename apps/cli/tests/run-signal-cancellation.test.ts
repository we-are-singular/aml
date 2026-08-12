import { EventEmitter } from "node:events"
import { setTimeout as delay } from "node:timers/promises"

import { describe, expect, it, vi } from "vitest"

import { RunSignalCancellation, type RunSignal } from "../src/run-signal-cancellation.js"

class SignalHost extends EventEmitter {
  readonly exit = vi.fn((_code: number): never => undefined as never)

  override off(signal: RunSignal, listener: () => void): this {
    return super.off(signal, listener)
  }

  override on(signal: RunSignal, listener: () => void): this {
    return super.on(signal, listener)
  }
}

describe("RunSignalCancellation", () => {
  it.each([
    { exitCode: 130, signal: "SIGINT" as const },
    { exitCode: 143, signal: "SIGTERM" as const },
  ])("aborts once and reports the conventional $signal exit code", ({ exitCode, signal }) => {
    const host = new SignalHost()
    const cancellation = new RunSignalCancellation(host)

    host.emit(signal)

    expect(cancellation.signal.aborted).toBe(true)
    expect(cancellation.signal.reason).toEqual(new Error(`aml run interrupted by ${signal}`))
    expect(cancellation.exitCode).toBe(exitCode)
    expect(host.exit).not.toHaveBeenCalled()
    cancellation.dispose()
    expect(host.listenerCount("SIGINT")).toBe(0)
    expect(host.listenerCount("SIGTERM")).toBe(0)
  })

  it("forces termination when graceful cleanup exceeds its deadline", async () => {
    const host = new SignalHost()
    const cancellation = new RunSignalCancellation(host, 1)

    host.emit("SIGTERM")
    await delay(10)

    expect(host.exit).toHaveBeenCalledWith(143)
    cancellation.dispose()
  })

  it("forces termination immediately when a second signal arrives", () => {
    const host = new SignalHost()
    const cancellation = new RunSignalCancellation(host)

    host.emit("SIGTERM")
    host.emit("SIGINT")

    expect(host.exit).toHaveBeenCalledWith(130)
    cancellation.dispose()
  })
})
