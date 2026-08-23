import { describe, expect, it, vi } from "vitest"

import { AbstractAgentProvider } from "../src/components/agent/abstract-agent-provider.js"
import type { AgentExecutionContext } from "../src/components/agent/agent-execution-context.js"
import type { AgentProvider } from "../src/components/agent/agent-provider.js"
import type { AgentProviderSession } from "../src/components/agent/agent-provider-session.js"
import type { AgentRequest } from "../src/components/agent/agent-request.js"
import { AgentTimeoutError } from "../src/components/agent/agent-timeout.js"
import { Agent } from "../src/components/agent/agent.js"
import { AmlRuntime } from "../src/core/aml-runtime.js"
import { evaluate } from "../src/core/evaluate.js"
import { EvaluationError } from "../src/core/evaluation-error.js"
import type { AmlTraceEvent } from "../src/observability/trace-event.js"

describe("Agent timeout", () => {
  it.each([0, -1, 1.5, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid timeoutMs %s before provider execution",
    async timeoutMs => {
      const provider = vi.fn<AgentProvider["run"]>()

      await expect(
        new AmlRuntime({ agentProvider: { name: "validation", run: provider } }).evaluate(
          <Agent timeoutMs={timeoutMs}>prompt</Agent>
        )
      ).rejects.toEqual(new EvaluationError("<Agent> timeoutMs must be a positive safe integer"))
      expect(provider).not.toHaveBeenCalled()
    }
  )

  it("passes timeoutMs to the provider request and clears a successful execution timer", async () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout")
    const provider: AgentProvider = {
      name: "success",
      async run(request) {
        expect(request.timeoutMs).toBe(60_000)
        return { text: "done" }
      },
    }

    try {
      await expect(
        new AmlRuntime({ agentProvider: provider }).evaluate(<Agent timeoutMs={60_000}>prompt</Agent>)
      ).resolves.toBe("done")
      expect(clearTimeoutSpy).toHaveBeenCalledOnce()
    } finally {
      clearTimeoutSpy.mockRestore()
    }
  })

  it("aborts on expiry and waits for provider cleanup before reporting completion", async () => {
    const events: AmlTraceEvent[] = []
    const lifecycle: string[] = []
    let finishCleanup: (() => void) | undefined
    const cleanupGate = new Promise<void>(resolve => {
      finishCleanup = resolve
    })
    const outerSignal = new AbortController().signal
    const removeListenerSpy = vi.spyOn(outerSignal, "removeEventListener")
    const provider = new SessionProvider("timeout-cleanup", (_request, context) => ({
      async abort() {
        lifecycle.push("abort")
      },
      async close() {
        lifecycle.push("cleanup:start")
        await cleanupGate
        lifecycle.push("cleanup:end")
      },
      async runTurn() {
        lifecycle.push("run")
        return await rejectOnAbort(context.signal)
      },
    }))
    const pending = new AmlRuntime({ trace: event => events.push(event) }).evaluate(
      <Agent provider={provider} timeoutMs={10}>
        prompt
      </Agent>,
      { signal: outerSignal }
    )

    await vi.waitFor(() => expect(lifecycle).toEqual(["run", "abort", "cleanup:start"]))
    let settled = false
    void pending.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      }
    )
    await Promise.resolve()
    expect(settled).toBe(false)

    finishCleanup?.()
    const error = await pending.catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(EvaluationError)
    expect(error).toHaveProperty("cause", expect.any(AgentTimeoutError))
    expect(lifecycle).toEqual(["run", "abort", "cleanup:start", "cleanup:end"])
    expect(removeListenerSpy).toHaveBeenCalledTimes(2)
    expect(
      events.find(
        event =>
          event.type === "event" &&
          event.name === "agent.session" &&
          event.attributes.state === "cancellation_requested"
      )
    ).toMatchObject({ attributes: { reason: "timeout", timeoutMs: 10 } })
    removeListenerSpy.mockRestore()
  })

  it("preserves caller cancellation as a distinct signal reason", async () => {
    const controller = new AbortController()
    const cancellation = new Error("caller stopped evaluation")
    const events: AmlTraceEvent[] = []
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout")
    const removeListenerSpy = vi.spyOn(controller.signal, "removeEventListener")
    const provider = new SessionProvider("caller-cancel", (_request, context) => sessionWaitingOn(context.signal))
    const pending = new AmlRuntime({ trace: event => events.push(event) }).evaluate(
      <Agent provider={provider} timeoutMs={60_000}>
        prompt
      </Agent>,
      {
        signal: controller.signal,
      }
    )

    await vi.waitFor(() => expect(provider.opened).toBe(1))
    controller.abort(cancellation)

    await expect(pending).rejects.toMatchObject({ cause: cancellation })
    expect(clearTimeoutSpy).toHaveBeenCalledOnce()
    expect(removeListenerSpy).toHaveBeenCalledTimes(2)
    const cancellationEvent = events.find(
      event =>
        event.type === "event" && event.name === "agent.session" && event.attributes.state === "cancellation_requested"
    )
    expect(cancellationEvent).toBeDefined()
    expect(cancellationEvent?.attributes).not.toHaveProperty("reason")
    expect(cancellationEvent?.attributes).not.toHaveProperty("timeoutMs")
    clearTimeoutSpy.mockRestore()
    removeListenerSpy.mockRestore()
  })

  it("rejects when timeout expires while provider cleanup is settling", async () => {
    const provider = new SessionProvider("cleanup-timeout", (_request, context) => ({
      async close() {
        await waitForAbort(context.signal)
      },
      async runTurn() {
        return { text: "turn completed" }
      },
    }))

    await expect(
      new AmlRuntime().evaluate(
        <Agent provider={provider} timeoutMs={10}>
          prompt
        </Agent>
      )
    ).rejects.toMatchObject({ cause: expect.any(AgentTimeoutError) })
  })

  it("retains timeout and cleanup failures in lifecycle order", async () => {
    const cleanupFailure = new Error("cleanup failed")
    const provider = new SessionProvider("cleanup-failure", (_request, context) => ({
      async close() {
        throw cleanupFailure
      },
      async runTurn() {
        return await rejectOnAbort(context.signal)
      },
    }))

    const error = await new AmlRuntime()
      .evaluate(
        <Agent provider={provider} timeoutMs={10}>
          prompt
        </Agent>
      )
      .catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(EvaluationError)
    expect(error).toHaveProperty(
      "cause",
      expect.objectContaining({
        errors: [expect.any(AgentTimeoutError), cleanupFailure],
      })
    )
  })

  it("keeps nested Agent timeout scopes independent", async () => {
    const requests: Array<{ prompt: string; timeoutMs: number | undefined }> = []
    const provider: AgentProvider = {
      name: "nested",
      async run(request, context) {
        requests.push({ prompt: request.prompt, timeoutMs: request.timeoutMs })

        if (request.prompt === "child") {
          return { text: "child-result" }
        }

        return await rejectOnAbort(context.signal)
      },
    }

    await expect(
      new AmlRuntime({ agentProvider: provider }).evaluate(
        <Agent timeoutMs={10}>
          <Agent timeoutMs={60_000}>child</Agent>
          parent
        </Agent>
      )
    ).rejects.toMatchObject({ cause: expect.any(AgentTimeoutError) })
    expect(requests).toEqual([
      { prompt: "child", timeoutMs: 60_000 },
      { prompt: "child-resultparent", timeoutMs: 10 },
    ])
  })

  it("does not let a nested Agent timeout scope weaken outer cancellation", async () => {
    const controller = new AbortController()
    const cancellation = new Error("outer evaluation cancelled")
    const calls: string[] = []
    const provider: AgentProvider = {
      name: "nested-outer-cancel",
      async run(request, context) {
        calls.push(request.prompt)
        return await rejectOnAbort(context.signal)
      },
    }
    const pending = new AmlRuntime({ agentProvider: provider }).evaluate(
      <Agent timeoutMs={60_000}>
        <Agent timeoutMs={60_000}>child</Agent>
        parent
      </Agent>,
      { signal: controller.signal }
    )

    await vi.waitFor(() => expect(calls).toEqual(["child"]))
    controller.abort(cancellation)

    await expect(pending).rejects.toMatchObject({ cause: cancellation })
    expect(calls).toEqual(["child"])
  })

  it("lets an outer Agent continue after a handled inner timeout", async () => {
    const calls: string[] = []
    const provider: AgentProvider = {
      name: "nested-inner-timeout",
      async run(request, context) {
        calls.push(request.prompt)

        if (request.prompt === "inner") {
          return await rejectOnAbort(context.signal)
        }

        return { text: "outer completed" }
      },
    }

    async function HandledInnerTimeout() {
      try {
        await evaluate(<Agent timeoutMs={10}>inner</Agent>)
      } catch (error) {
        expect(error).toMatchObject({ cause: expect.any(AgentTimeoutError) })
      }

      return "inner timed out; "
    }

    await expect(
      new AmlRuntime({ agentProvider: provider }).evaluate(
        <Agent timeoutMs={60_000}>
          <HandledInnerTimeout />
          outer
        </Agent>
      )
    ).resolves.toBe("outer completed")
    expect(calls).toEqual(["inner", "inner timed out; outer"])
  })

  it.each([false, true])("releases the scheduler slot after timeout cleanup (fails: %s)", async cleanupFails => {
    const calls: string[] = []
    const cleanupFailure = new Error("expected cleanup failure")
    const provider = new SessionProvider("slot-release", (request, context) => {
      calls.push(request.prompt)

      if (request.prompt === "continues") {
        return {
          async close() {},
          async runTurn() {
            return { text: "recovered" }
          },
        }
      }

      return {
        async close() {
          if (cleanupFails) throw cleanupFailure
        },
        async runTurn() {
          return await rejectOnAbort(context.signal)
        },
      }
    })

    async function Workflow() {
      await Promise.allSettled([
        evaluate(<Agent timeoutMs={10}>timeout-cleanup-fails</Agent>),
        evaluate(<Agent>continues</Agent>),
      ])
      return "done"
    }

    await expect(
      new AmlRuntime({ agentProvider: provider, maxConcurrentAgents: 1 }).evaluate(<Workflow />)
    ).resolves.toBe("done")
    expect(calls).toEqual(["timeout-cleanup-fails", "continues"])
  })
})

class SessionProvider extends AbstractAgentProvider<string> {
  opened = 0
  readonly #createSession: (request: AgentRequest, context: AgentExecutionContext) => AgentProviderSession

  constructor(
    name: string,
    createSession: (request: AgentRequest, context: AgentExecutionContext) => AgentProviderSession
  ) {
    super(name)
    this.#createSession = createSession
  }

  protected async openSession(request: AgentRequest, context: AgentExecutionContext): Promise<AgentProviderSession> {
    this.opened += 1
    return this.#createSession(request, context)
  }
}

function sessionWaitingOn(signal: AbortSignal): AgentProviderSession {
  return {
    async close() {},
    async runTurn() {
      return await rejectOnAbort(signal)
    },
  }
}

async function rejectOnAbort(signal: AbortSignal): Promise<never> {
  return await new Promise<never>((_resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }

    signal.addEventListener("abort", () => reject(signal.reason), { once: true })
  })
}

async function waitForAbort(signal: AbortSignal): Promise<void> {
  try {
    await rejectOnAbort(signal)
  } catch (error) {
    if (error !== signal.reason) throw error
  }
}
