import { describe, expect, it, vi } from "vitest"

import { Agent } from "../src/components/agent/agent.js"
import type { AgentProvider } from "../src/components/agent/agent-provider.js"
import { AmlRuntime } from "../src/core/aml-runtime.js"

describe("runtime events", () => {
  it("publishes start, trace, and finish through one runtime surface", async () => {
    const calls: string[] = []
    let runId: string | undefined
    const runtime = new AmlRuntime()

    runtime.on("start", (event) => {
      runId = event.runId
      calls.push("start")
      expect(Object.isFrozen(event)).toBe(true)
    })
    runtime.on("trace", (event) => {
      expect(event.runId).toBe(runId)
      calls.push(`trace:${event.type}`)
    })
    runtime.on("finish", (event) => {
      expect(event.runId).toBe(runId)
      expect(event.status).toBe("ok")
      calls.push("finish")
    })

    await expect(runtime.evaluate("done")).resolves.toBe("done")

    expect(calls[0]).toBe("start")
    expect(calls[1]).toBe("trace:span.start")
    expect(calls.at(-2)).toBe("finish")
    expect(calls.at(-1)).toBe("trace:span.end")
  })

  it("removes a runtime once listener before another evaluation", async () => {
    const listener = vi.fn()
    const runtime = new AmlRuntime()

    runtime.once("finish", listener)

    await runtime.evaluate("first")
    await runtime.evaluate("second")

    expect(listener).toHaveBeenCalledTimes(1)
  })

  it("gives providers evaluation-scoped finish subscriptions", async () => {
    const calls: string[] = []
    const registeredRuns = new Set<string>()
    const provider: AgentProvider = {
      name: "event-aware",
      async run(_request, context) {
        const runId = context.trace.runId

        if (!registeredRuns.has(runId)) {
          registeredRuns.add(runId)
          context.events.once("finish", (event) => {
            calls.push(`finish:${event.runId}`)
          })
        }

        calls.push(`run:${runId}`)
        return { text: "done" }
      },
    }

    await expect(
      new AmlRuntime().evaluate([
        <Agent provider={provider}>first</Agent>,
        <Agent provider={provider}>second</Agent>,
      ]),
    ).resolves.toBe("donedone")

    const runIds = calls
      .filter((call) => call.startsWith("run:"))
      .map((call) => call.slice("run:".length))

    expect(new Set(runIds).size).toBe(1)
    expect(calls).toEqual([
      `run:${runIds[0]}`,
      `run:${runIds[0]}`,
      `finish:${runIds[0]}`,
    ])
  })

  it("rejects a successful evaluation when a finish listener fails", async () => {
    const failure = new Error("finish failed")
    const runtime = new AmlRuntime()

    runtime.on("finish", () => {
      throw failure
    })

    await expect(runtime.evaluate("done")).rejects.toBe(failure)
  })

  it("runs every finish listener and preserves multiple failures", async () => {
    const first = new Error("first finish failed")
    const second = new Error("second finish failed")
    const runtime = new AmlRuntime()

    runtime.on("finish", () => {
      throw first
    })
    runtime.on("finish", () => {
      throw second
    })

    const error = await runtime
      .evaluate("done")
      .catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(AggregateError)
    expect(error).toHaveProperty("errors", [first, second])
  })

  it("isolates trace-hook failures from evaluation", async () => {
    const errors: unknown[] = []
    const runtime = new AmlRuntime({
      onTraceError(error) {
        errors.push(error)
      },
    })

    runtime.on("trace", () => {
      throw new Error("observer failed")
    })

    await expect(runtime.evaluate("done")).resolves.toBe("done")
    await new Promise((resolve) => setImmediate(resolve))

    expect(errors).toEqual([
      expect.objectContaining({ message: "observer failed" }),
      expect.objectContaining({ message: "observer failed" }),
    ])
  })

  it("preserves evaluation and finish failures together", async () => {
    const executionFailure = new Error("execution failed")
    const finishFailure = new Error("finish failed")
    const provider: AgentProvider = {
      name: "broken",
      async run() {
        throw executionFailure
      },
    }
    const runtime = new AmlRuntime()

    runtime.on("finish", () => {
      throw finishFailure
    })

    const error = await runtime
      .evaluate(<Agent provider={provider}>prompt</Agent>)
      .catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(AggregateError)
    expect(error).toHaveProperty(
      "message",
      "AML evaluation and finish listeners both failed",
    )
    expect((error as AggregateError).errors[0]).toHaveProperty(
      "cause",
      executionFailure,
    )
    expect((error as AggregateError).errors[1]).toBe(finishFailure)
  })
})
