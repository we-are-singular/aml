import { describe, expect, it, vi } from "vitest"
import { z } from "zod"

import { Agent } from "../src/components/agent/agent.js"
import type { AgentProvider } from "../src/components/agent/agent-provider.js"
import type { AgentResponse } from "../src/components/agent/agent-response.js"
import { AmlRuntime } from "../src/core/aml-runtime.js"
import { evaluate } from "../src/core/evaluate.js"

describe("Agent concurrency", () => {
  it("runs explicit branches concurrently and preserves synthesis order", async () => {
    const events: string[] = []
    let active = 0
    let maxActive = 0
    let releaseFast: (() => void) | undefined
    let releaseSlow: (() => void) | undefined
    const fastGate = new Promise<void>(resolve => {
      releaseFast = resolve
    })
    const slowGate = new Promise<void>(resolve => {
      releaseSlow = resolve
    })
    const provider: AgentProvider = {
      name: "ordered-concurrency",
      async run(request) {
        active += 1
        maxActive = Math.max(maxActive, active)
        events.push(`${request.prompt}:start`)

        if (request.prompt === "slow") {
          await slowGate
          active -= 1
          events.push("slow:end")
          return { text: "slow-result" }
        }

        if (request.prompt === "fast") {
          await fastGate
          active -= 1
          events.push("fast:end")
          return { text: "fast-result" }
        }

        expect(request.prompt).toBe("synthesize:slow-result|fast-result")
        active -= 1
        events.push("synthesize:end")
        return { text: "final" }
      },
    }

    async function Workflow() {
      const [slow, fast] = await Promise.all([evaluate(<Agent>slow</Agent>), evaluate(<Agent>fast</Agent>)])

      return (
        <Agent>
          synthesize:{slow}|{fast}
        </Agent>
      )
    }

    const result = new AmlRuntime({
      agentProvider: provider,
      maxConcurrentAgents: 2,
    }).evaluate(<Workflow />)

    await vi.waitFor(() => {
      expect(events).toEqual(["slow:start", "fast:start"])
    })
    releaseFast?.()
    await vi.waitFor(() => {
      expect(events).toContain("fast:end")
    })
    expect(events).not.toContain("synthesize:end")
    releaseSlow?.()

    await expect(result).resolves.toBe("final")
    expect(maxActive).toBe(2)
    expect(events).toEqual([
      "slow:start",
      "fast:start",
      "fast:end",
      "slow:end",
      "synthesize:slow-result|fast-result:start",
      "synthesize:end",
    ])
  })

  it("finishes post-order child Agents before a limited parent starts", async () => {
    const calls: string[] = []
    let active = 0
    let maxActive = 0
    const provider: AgentProvider = {
      name: "post-order-concurrency",
      async run(request) {
        calls.push(request.prompt)
        active += 1
        maxActive = Math.max(maxActive, active)
        await Promise.resolve()
        active -= 1
        return {
          text: request.prompt === "child" ? "child-result" : "parent-result",
        }
      },
    }

    await expect(
      new AmlRuntime({
        agentProvider: provider,
        maxConcurrentAgents: 1,
      }).evaluate(
        <Agent>
          <Agent>child</Agent>
          parent
        </Agent>
      )
    ).resolves.toBe("parent-result")
    expect(calls).toEqual(["child", "child-resultparent"])
    expect(maxActive).toBe(1)
  })

  it("uses four active Agent calls by default", async () => {
    let active = 0
    let calls = 0
    let maxActive = 0
    let release: (() => void) | undefined
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const provider: AgentProvider = {
      name: "default-concurrency",
      async run(request) {
        calls += 1
        active += 1
        maxActive = Math.max(maxActive, active)
        await gate
        active -= 1
        return { text: request.prompt }
      },
    }

    async function Workflow() {
      return (await Promise.all(Array.from({ length: 5 }, (_, index) => evaluate(<Agent>{index}</Agent>)))).join("")
    }

    const result = new AmlRuntime({
      agentProvider: provider,
    }).evaluate(<Workflow />)

    await vi.waitFor(() => {
      expect(calls).toBe(4)
    })
    expect(maxActive).toBe(4)
    release?.()

    await expect(result).resolves.toBe("01234")
    expect(calls).toBe(5)
    expect(maxActive).toBe(4)
  })

  it("starts queued Agent calls in ready order", async () => {
    const calls: string[] = []
    const releases = new Map<string, () => void>()
    const provider: AgentProvider = {
      name: "fifo-concurrency",
      async run(request) {
        calls.push(request.prompt)
        await new Promise<void>(resolve => {
          releases.set(request.prompt, resolve)
        })
        return { text: request.prompt }
      },
    }

    async function Workflow() {
      return (
        await Promise.all([
          evaluate(<Agent>first</Agent>),
          evaluate(<Agent>second</Agent>),
          evaluate(<Agent>third</Agent>),
        ])
      ).join("|")
    }

    const result = new AmlRuntime({
      agentProvider: provider,
      maxConcurrentAgents: 1,
    }).evaluate(<Workflow />)

    await vi.waitFor(() => {
      expect(calls).toEqual(["first"])
    })
    releases.get("first")?.()
    await vi.waitFor(() => {
      expect(calls).toEqual(["first", "second"])
    })
    releases.get("second")?.()
    await vi.waitFor(() => {
      expect(calls).toEqual(["first", "second", "third"])
    })
    releases.get("third")?.()

    await expect(result).resolves.toBe("first|second|third")
  })

  it("releases a failed provider slot to the next queued Agent", async () => {
    const calls: string[] = []
    const provider: AgentProvider = {
      name: "failure-concurrency",
      async run(request) {
        calls.push(request.prompt)

        if (request.prompt === "fails") {
          throw new Error("expected failure")
        }

        return { text: "recovered" }
      },
    }

    async function Workflow() {
      const [failed, recovered] = await Promise.allSettled([
        evaluate(<Agent>fails</Agent>),
        evaluate(<Agent>continues</Agent>),
      ])

      expect(failed.status).toBe("rejected")
      expect(recovered).toEqual({
        status: "fulfilled",
        value: "recovered",
      })
      return "done"
    }

    await expect(
      new AmlRuntime({
        agentProvider: provider,
        maxConcurrentAgents: 1,
      }).evaluate(<Workflow />)
    ).resolves.toBe("done")
    expect(calls).toEqual(["fails", "continues"])
  })

  it("keeps schedulers independent across root evaluations", async () => {
    let active = 0
    let calls = 0
    let maxActive = 0
    let release: (() => void) | undefined
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const provider: AgentProvider = {
      name: "root-concurrency",
      async run(request) {
        calls += 1
        active += 1
        maxActive = Math.max(maxActive, active)
        await gate
        active -= 1
        return { text: request.prompt }
      },
    }
    const runtime = new AmlRuntime({
      agentProvider: provider,
      maxConcurrentAgents: 1,
    })
    const first = runtime.evaluate(<Agent>first</Agent>)
    const second = runtime.evaluate(<Agent>second</Agent>)

    await vi.waitFor(() => {
      expect(calls).toBe(2)
    })
    expect(maxActive).toBe(2)
    release?.()

    await expect(Promise.all([first, second])).resolves.toEqual(["first", "second"])
  })

  it("treats zero as unlimited Agent concurrency", async () => {
    let active = 0
    let calls = 0
    let maxActive = 0
    let release: (() => void) | undefined
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const provider: AgentProvider = {
      name: "unlimited-concurrency",
      async run(request) {
        calls += 1
        active += 1
        maxActive = Math.max(maxActive, active)
        await gate
        active -= 1
        return { text: request.prompt }
      },
    }

    async function Workflow() {
      return (await Promise.all(Array.from({ length: 6 }, (_, index) => evaluate(<Agent>{index}</Agent>)))).join("")
    }

    const result = new AmlRuntime({
      agentProvider: provider,
      maxConcurrentAgents: 0,
    }).evaluate(<Workflow />)

    await vi.waitFor(() => {
      expect(calls).toBe(6)
    })
    expect(maxActive).toBe(6)
    release?.()

    await expect(result).resolves.toBe("012345")
  })

  it("rejects queued Agents on cancellation without starting them", async () => {
    const controller = new AbortController()
    const cancellation = new Error("cancel queued Agents")
    const calls: string[] = []
    const provider: AgentProvider = {
      name: "cancel-concurrency",
      run(request, context) {
        calls.push(request.prompt)

        return new Promise((_resolve, reject) => {
          context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true })
        })
      },
    }

    async function Workflow() {
      await Promise.all([evaluate(<Agent>active</Agent>), evaluate(<Agent>queued</Agent>)])
      return "unreachable"
    }

    const result = new AmlRuntime({
      agentProvider: provider,
      maxConcurrentAgents: 1,
    }).evaluate(<Workflow />, { signal: controller.signal })

    await vi.waitFor(() => {
      expect(calls).toEqual(["active"])
    })
    controller.abort(cancellation)

    const error = await result.catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(AggregateError)
    expect(error).toHaveProperty("errors", [
      expect.objectContaining({ cause: cancellation }),
      expect.objectContaining({ cause: cancellation }),
    ])
    expect(
      (error as AggregateError).errors.some(
        nested => nested instanceof Error && nested.message.includes("was cancelled before provider execution")
      )
    ).toBe(true)
    expect(calls).toEqual(["active"])
  })

  it("rejects provider-reentrant evaluation instead of deadlocking", async () => {
    const calls: string[] = []
    let nestedError: unknown
    const provider: AgentProvider = {
      name: "reentrant-concurrency",
      async run(request) {
        calls.push(request.prompt)

        try {
          await evaluate(<Agent>nested</Agent>)
        } catch (error) {
          nestedError = error
        }

        return { text: "outer-result" }
      },
    }

    async function Workflow() {
      return await evaluate(<Agent>outer</Agent>)
    }

    await expect(
      new AmlRuntime({
        agentProvider: provider,
        maxConcurrentAgents: 1,
      }).evaluate(<Workflow />)
    ).resolves.toBe("outer-result")
    expect(nestedError).toMatchObject({
      message: "evaluate() is only available while an AML component is active",
    })
    expect(calls).toEqual(["outer"])
  })

  it("masks reentrant evaluation during provider Promise assimilation", async () => {
    const calls: string[] = []
    let nestedError: unknown
    const provider: AgentProvider = {
      name: "thenable-concurrency",
      run(request) {
        calls.push(request.prompt)

        if (request.prompt === "nested") {
          return Promise.resolve({ text: "nested-result" })
        }

        return {
          then(resolve: (value: AgentResponse) => void) {
            try {
              void evaluate(<Agent provider={provider}>nested</Agent>)
              nestedError = new Error("provider thenable retained evaluate() access")
            } catch (error) {
              nestedError = error
            }

            resolve({ text: "outer-result" })
          },
        } as unknown as Promise<AgentResponse>
      },
    }

    async function Workflow() {
      return await evaluate(<Agent provider={provider}>outer</Agent>)
    }

    await expect(new AmlRuntime({ maxConcurrentAgents: 1 }).evaluate(<Workflow />)).resolves.toBe("outer-result")
    expect(nestedError).toMatchObject({
      message: "evaluate() is only available while an AML component is active",
    })
    expect(calls).toEqual(["outer"])
  })

  it("masks reentrant evaluation from provider response accessors", async () => {
    const calls: string[] = []
    let getterError: unknown
    const provider: AgentProvider = {
      name: "response-getter-concurrency",
      async run(request) {
        calls.push(request.prompt)

        if (request.prompt === "injected") {
          return { text: "injected-result" }
        }

        return {
          get text() {
            try {
              void evaluate(<Agent provider={provider}>injected</Agent>)
              getterError = new Error("provider response retained evaluate() access")
            } catch (error) {
              getterError = error
            }

            return "outer-result"
          },
        }
      },
    }

    async function Workflow() {
      return await evaluate(<Agent provider={provider}>outer</Agent>)
    }

    await expect(new AmlRuntime({ maxConcurrentAgents: 1 }).evaluate(<Workflow />)).resolves.toBe("outer-result")
    expect(getterError).toMatchObject({
      message: "evaluate() is only available while an AML component is active",
    })
    expect(calls).toEqual(["outer"])
  })

  it("masks nested structured-output accessors during validation", async () => {
    const calls: string[] = []
    let getterError: unknown
    const provider: AgentProvider = {
      name: "structured-getter-concurrency",
      async run(request) {
        calls.push(request.prompt)

        if (request.prompt === "injected") {
          return { text: "injected-result" }
        }

        return {
          structured: {
            get value() {
              try {
                void evaluate(<Agent provider={provider}>injected</Agent>)
                getterError = new Error("structured value retained evaluate() access")
              } catch (error) {
                getterError = error
              }

              return "safe"
            },
          },
          text: "",
        }
      },
    }
    const Result = z.object({ value: z.string() })

    async function Workflow() {
      const result = await evaluate(<Agent provider={provider}>outer</Agent>, Result)
      return result.value
    }

    await expect(new AmlRuntime().evaluate(<Workflow />)).resolves.toBe("safe")
    expect(getterError).toMatchObject({
      message: "evaluate() is only available while an AML component is active",
    })
    expect(calls).toEqual(["outer"])
  })

  it("masks reentrant evaluation from explicit provider accessors", async () => {
    let accessorError: unknown
    const injectedCalls: string[] = []
    const injectedProvider: AgentProvider = {
      name: "injected-provider",
      async run(request) {
        injectedCalls.push(request.prompt)
        return { text: "injected" }
      },
    }
    const provider: AgentProvider = {
      get name() {
        try {
          void evaluate(<Agent provider={injectedProvider}>injected</Agent>)
          accessorError = new Error("provider accessor retained evaluate() access")
        } catch (error) {
          accessorError = error
        }

        return "accessor-concurrency"
      },
      async run() {
        return { text: "outer-result" }
      },
    }

    async function Workflow() {
      return await evaluate(<Agent provider={provider}>outer</Agent>)
    }

    await expect(new AmlRuntime().evaluate(<Workflow />)).resolves.toBe("outer-result")
    expect(accessorError).toMatchObject({
      message: "evaluate() is only available while an AML component is active",
    })
    expect(injectedCalls).toEqual([])
  })

  it("rejects invalid concurrency limits before evaluation", () => {
    for (const value of [-1, 1.5, Number.NaN]) {
      expect(() => new AmlRuntime({ maxConcurrentAgents: value })).toThrow(
        "maxConcurrentAgents must be a non-negative safe integer"
      )
    }
  })
})
