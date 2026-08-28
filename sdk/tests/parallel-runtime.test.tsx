import { describe, expect, it, vi } from "vitest"
import { z } from "zod"

import { Agent } from "../src/components/agent/agent.js"
import type { AgentProvider } from "../src/components/agent/agent-provider.js"
import { createContext } from "../src/components/context/create-context.js"
import { useContext } from "../src/components/context/use-context.js"
import { Parallel, ParallelError } from "../src/components/parallel/parallel.js"
import { Sandbox } from "../src/components/sandbox/sandbox.js"
import { System } from "../src/components/system/system.js"
import { AmlRuntime } from "../src/core/aml-runtime.js"
import { DeterministicAgentProvider } from "../src/testing/deterministic-agent-provider.js"
import { DeterministicSandboxProvider } from "../src/testing/deterministic-sandbox-provider.js"

describe("Parallel", () => {
  it("overlaps flattened branches and renders their results in authored order", async () => {
    const events: string[] = []
    let releaseFast: (() => void) | undefined
    let releaseSlow: (() => void) | undefined
    const fastGate = new Promise<void>(resolve => {
      releaseFast = resolve
    })
    const slowGate = new Promise<void>(resolve => {
      releaseSlow = resolve
    })
    const provider = new DeterministicAgentProvider({
      async respond(request) {
        events.push(`${request.prompt}:start`)

        if (request.prompt === "slow") {
          await slowGate
        } else {
          await fastGate
        }

        events.push(`${request.prompt}:end`)
        return { text: `${request.prompt}-result` }
      },
    })

    const evaluation = new AmlRuntime({ agentProvider: provider }).evaluate(
      <Parallel>{[<Agent>slow</Agent>, [null, false, <Agent>fast</Agent>]]}</Parallel>
    )

    await vi.waitFor(() => expect(events).toEqual(["slow:start", "fast:start"]))
    releaseFast?.()
    await vi.waitFor(() => expect(events).toContain("fast:end"))
    releaseSlow?.()

    await expect(evaluation).resolves.toBe("slow-resultfast-result")
    expect(events).toEqual(["slow:start", "fast:start", "fast:end", "slow:end"])
  })

  it("renders Agent-owned structured output as ordered JSON text", async () => {
    const LaneResult = z.object({ lane: z.string(), passed: z.boolean() })
    const provider = new DeterministicAgentProvider({
      respond: request => ({
        structured: { lane: request.prompt, passed: true },
        text: "ignored",
      }),
    })

    await expect(
      new AmlRuntime({ agentProvider: provider }).evaluate(
        <Parallel>
          <Agent schema={LaneResult}>correctness</Agent>
          <Agent schema={LaneResult}>security</Agent>
        </Parallel>
      )
    ).resolves.toBe('{"lane":"correctness","passed":true}{"lane":"security","passed":true}')
  })

  it("relies on maxConcurrentAgents to bound provider calls", async () => {
    let active = 0
    let calls = 0
    let maxActive = 0
    let release: (() => void) | undefined
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const provider = new DeterministicAgentProvider({
      async respond(request) {
        calls += 1
        active += 1
        maxActive = Math.max(maxActive, active)
        await gate
        active -= 1
        return { text: request.prompt }
      },
    })

    const evaluation = new AmlRuntime({
      agentProvider: provider,
      maxConcurrentAgents: 2,
    }).evaluate(
      <Parallel>
        {Array.from({ length: 5 }, (_, index) => (
          <Agent>{index}</Agent>
        ))}
      </Parallel>
    )

    await vi.waitFor(() => expect(calls).toBe(2))
    expect(maxActive).toBe(2)
    release?.()

    await expect(evaluation).resolves.toBe("01234")
    expect(calls).toBe(5)
    expect(maxActive).toBe(2)
  })

  it("cancels active branches without starting queued Agents", async () => {
    const controller = new AbortController()
    const cancellation = new Error("stop Parallel")
    const calls: string[] = []
    const provider: AgentProvider = {
      name: "parallel-cancellation",
      run(request, context) {
        calls.push(request.prompt)

        return new Promise((_resolve, reject) => {
          context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true })
        })
      },
    }

    const evaluation = new AmlRuntime({
      agentProvider: provider,
      maxConcurrentAgents: 1,
    }).evaluate(
      <Parallel>
        <Agent>first</Agent>
        <Agent>second</Agent>
        <Agent>third</Agent>
      </Parallel>,
      { signal: controller.signal }
    )

    await vi.waitFor(() => expect(calls).toEqual(["first"]))
    controller.abort(cancellation)

    const error = await evaluation.catch(error => error as unknown)
    expect(error).toBeInstanceOf(ParallelError)
    const failures = (error as ParallelError).failures
    expect(failures.map(failure => failure.branchIndex)).toEqual([0, 1, 2])

    for (const failure of failures) {
      expect((failure.cause as Error).cause).toBe(cancellation)
    }

    expect(calls).toEqual(["first"])
  })

  it("identifies a single failed flattened branch and preserves its cause", async () => {
    const cause = new Error("lane failed")

    function FailingLane(): never {
      throw cause
    }

    const error = await new AmlRuntime()
      .evaluate(<Parallel>{["first", [null, <FailingLane />]]}</Parallel>)
      .catch(error => error as unknown)

    expect(error).toBeInstanceOf(ParallelError)
    expect(error).toMatchObject({
      failures: [{ branchIndex: 1, cause }],
      message: "<Parallel> branch 2 failed",
    })
  })

  it("waits for every branch and aggregates failures in authored order", async () => {
    const first = new Error("first failed")
    const third = new Error("third failed")
    let finishSecond: (() => void) | undefined
    const secondGate = new Promise<void>(resolve => {
      finishSecond = resolve
    })
    const events: string[] = []

    function FailingLane({ error }: Readonly<{ error: Error }>): never {
      events.push(error.message)
      throw error
    }

    async function SlowLane() {
      events.push("second:start")
      await secondGate
      events.push("second:end")
      return "second"
    }

    const evaluation = new AmlRuntime().evaluate(
      <Parallel>
        <FailingLane error={first} />
        <SlowLane />
        <FailingLane error={third} />
      </Parallel>
    )

    await vi.waitFor(() => expect(events).toEqual(["first failed", "second:start", "third failed"]))
    let settled = false
    void evaluation.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      }
    )
    await Promise.resolve()
    expect(settled).toBe(false)
    finishSecond?.()

    const error = await evaluation.catch(error => error as unknown)
    expect(error).toBeInstanceOf(ParallelError)
    expect(error).toMatchObject({ message: "<Parallel> branches 1, 3 failed" })
    expect((error as ParallelError).failures).toMatchObject([
      { branchIndex: 0, cause: first },
      { branchIndex: 2, cause: third },
    ])
    expect(events).toEqual(["first failed", "second:start", "third failed", "second:end"])
  })

  it("inherits Context and keeps branch-local Providers isolated", async () => {
    const LaneContext = createContext("ParallelLane", "outer")

    function ReadLane() {
      return useContext(LaneContext)
    }

    await expect(
      new AmlRuntime().evaluate(
        <Parallel>
          <LaneContext.Provider value="inner">
            <ReadLane />
          </LaneContext.Provider>
          <ReadLane />
        </Parallel>
      )
    ).resolves.toBe("innerouter")
  })

  it("supports nested Parallel components", async () => {
    await expect(
      new AmlRuntime().evaluate(
        <Parallel>
          <Parallel>{["a", "b"]}</Parallel>
          <Parallel>{["c", "d"]}</Parallel>
        </Parallel>
      )
    ).resolves.toBe("abcd")
  })

  it("joins branch cleanup before releasing an inherited Sandbox", async () => {
    let finishSecond: (() => void) | undefined
    const secondGate = new Promise<void>(resolve => {
      finishSecond = resolve
    })
    const sandboxProvider = new DeterministicSandboxProvider()
    const provider: AgentProvider = {
      name: "parallel-cleanup",
      async run(request) {
        if (request.prompt === "fails") {
          throw new Error("expected failure")
        }

        await secondGate
        return { text: "done" }
      },
      supportsSandbox: () => true,
    }

    const evaluation = new AmlRuntime({ agentProvider: provider }).evaluate(
      <Sandbox provider={sandboxProvider}>
        <Parallel>
          <Agent>fails</Agent>
          <Agent>waits</Agent>
        </Parallel>
      </Sandbox>
    )

    await vi.waitFor(() => expect(provider).toMatchObject({ name: "parallel-cleanup" }))
    expect(sandboxProvider.releases).toHaveLength(0)
    finishSecond?.()

    await expect(evaluation).rejects.toMatchObject({ failures: [{ branchIndex: 0 }] })
    expect(sandboxProvider.releases).toHaveLength(1)
  })

  it("keeps Agent descriptors inside their own branches", async () => {
    const error = await new AmlRuntime()
      .evaluate(
        <Agent provider={new DeterministicAgentProvider()}>
          <Parallel>
            <System>not a surrounding Agent descriptor</System>
          </Parallel>
        </Agent>
      )
      .catch(error => error as unknown)

    expect(error).toMatchObject({
      failures: [
        {
          branchIndex: 0,
          cause: expect.objectContaining({ message: "<System> is only valid inside <Agent>" }),
        },
      ],
    })
  })
})
