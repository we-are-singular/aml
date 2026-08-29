import { z } from "zod"
import { describe, expect, expectTypeOf, it, vi } from "vitest"

import { Agent } from "../src/components/agent/agent.js"
import { Loop } from "../src/components/loop/loop.js"
import { Sandbox } from "../src/components/sandbox/sandbox.js"
import { defineTool } from "../src/components/tool/define-tool.js"
import { AmlRuntime } from "../src/core/aml-runtime.js"
import { evaluate } from "../src/core/evaluate.js"
import type { AmlTraceEvent } from "../src/observability/trace-event.js"
import type { TraceSink } from "../src/observability/trace-sink.js"
import { DeterministicSandboxProvider } from "../src/testing/deterministic-sandbox-provider.js"
import { DeterministicAgentProvider } from "../src/testing/deterministic-agent-provider.js"

describe("callable Tool", () => {
  it("invokes exact Tools from nested and concurrent component branches", async () => {
    const calls: number[] = []
    const double = defineTool({
      description: "Double one number",
      execute: async ({ value }) => {
        calls.push(value)
        await Promise.resolve()
        return { value: value * 2 }
      },
      input: z.object({ value: z.number() }),
      name: "double",
      output: z.object({ value: z.number() }),
    })

    async function Child({ value }: { readonly value: number }) {
      const result = await double({ value })
      expectTypeOf(result).toEqualTypeOf<{ value: number }>()
      return String(result.value)
    }

    async function Parent() {
      const [first, second] = await Promise.all([evaluate(<Child value={1} />), evaluate(<Child value={2} />)])
      return `${first}:${second}`
    }

    await expect(new AmlRuntime().evaluate(<Parent />)).resolves.toBe("2:4")
    expect(calls).toEqual([1, 2])
  })

  it("inherits cancellation and rejects before application code starts when already aborted", async () => {
    const controller = new AbortController()
    const execute = vi.fn(() => "unreachable")
    const tool = defineTool({
      description: "Must not run",
      execute,
      input: z.object({}),
      name: "pre_aborted",
    })

    async function Workflow() {
      controller.abort(new Error("cancelled"))
      await tool({})
      return "unreachable"
    }

    await expect(new AmlRuntime().evaluate(<Workflow />, { signal: controller.signal })).rejects.toThrow("cancelled")
    expect(execute).not.toHaveBeenCalled()
  })

  it("passes the evaluation signal to an active Tool invocation", async () => {
    const controller = new AbortController()
    let started: (() => void) | undefined
    const active = new Promise<void>(resolve => {
      started = resolve
    })
    const tool = defineTool({
      description: "Wait for cancellation",
      execute: async (_input, { signal }) => {
        started?.()
        await new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }))
        return "unreachable"
      },
      input: z.object({}),
      name: "cancel_active",
    })

    async function Workflow() {
      await tool({})
      return "unreachable"
    }

    const evaluation = new AmlRuntime().evaluate(<Workflow />, { signal: controller.signal })
    await active
    controller.abort(new Error("stop active Tool"))
    await expect(evaluation).rejects.toThrow("stop active Tool")
  })

  it("redacts content by default and labels application invocation spans", async () => {
    async function run(captureContent: boolean) {
      const events: AmlTraceEvent[] = []
      const sink = ((event: AmlTraceEvent) => events.push(event)) as TraceSink

      if (captureContent) {
        Object.defineProperty(sink, "captureContent", { value: true })
      }

      const secretTool = defineTool({
        description: "Echo a secret",
        execute: ({ secret }) => ({ secret }),
        input: z.object({ secret: z.string() }),
        name: "application_secret",
      })

      async function Workflow() {
        await secretTool({ secret: "TOOL_SECRET" })
        return "done"
      }

      await new AmlRuntime({ trace: sink }).evaluate(<Workflow />)
      return events
    }

    const hidden = await run(false)
    const visible = await run(true)
    const hiddenToolStart = hidden.find(event => event.type === "span.start" && event.kind === "tool")
    const visibleToolStart = visible.find(event => event.type === "span.start" && event.kind === "tool")

    expect(hiddenToolStart?.attributes).toEqual({ invocation: "application" })
    expect(visibleToolStart?.attributes).toEqual({
      input: '{"secret":"TOOL_SECRET"}',
      invocation: "application",
    })
    expect(JSON.stringify(hidden)).not.toContain("TOOL_SECRET")
  })

  it("parents Loop wrapper invocations to the active component span", async () => {
    const events: AmlTraceEvent[] = []
    const tool = defineTool({
      description: "Read application state",
      execute: () => "ready",
      input: z.object({}),
      name: "loop_application",
      output: z.string(),
    })

    async function Wrapper() {
      const status = await tool({})
      return <Agent>{status}</Agent>
    }

    await new AmlRuntime({
      agentProvider: new DeterministicAgentProvider({ respond: () => ({ text: "done" }) }),
      trace: event => events.push(event),
    }).evaluate(<Loop initial={{ done: true }} render={() => <Wrapper />} schema={z.object({ done: z.boolean() })} />)

    const component = events.find(
      event => event.type === "span.start" && event.kind === "component" && event.name === "Wrapper"
    )
    const invocation = events.find(event => event.type === "span.start" && event.kind === "tool")

    expect(invocation?.parentSpanId).toBe(component?.spanId)
  })

  it("preserves validation without granting the Tool to an enclosing Agent", async () => {
    const execute = vi.fn(({ id }: { id: number }) => ({ id }))
    const tool = defineTool({
      description: "Validate one ID",
      execute,
      input: z.object({ id: z.number() }),
      name: "application_only",
      output: z.object({ id: z.number().positive() }),
    })
    const provider = new DeterministicAgentProvider({
      respond(request) {
        expect(request.tools).toEqual([])
        return { text: "model result" }
      },
    })

    async function Workflow() {
      await expect(tool({ id: "invalid" } as never)).rejects.toThrow("input failed schema validation")
      await expect(tool({ id: -1 })).rejects.toThrow("output failed schema validation")
      return <Agent>continue</Agent>
    }

    await expect(new AmlRuntime({ agentProvider: provider }).evaluate(<Workflow />)).resolves.toBe("model result")
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it("rejects calls outside the active component lifetime", async () => {
    const execute = vi.fn(() => "safe")
    const tool = defineTool({
      description: "Call only while active",
      execute,
      input: z.object({}),
      name: "component_local",
    })

    expect(() => tool({})).toThrow("Tools can only be called while an AML component is active")

    let detached: (() => Promise<unknown>) | undefined

    async function Workflow() {
      detached = () => tool({})
      await tool({})
      return "done"
    }

    await expect(new AmlRuntime().evaluate(<Workflow />)).resolves.toBe("done")
    expect(execute).toHaveBeenCalledTimes(1)
    expect(() => detached?.()).toThrow("Tools can only be called while an AML component is active")
  })

  it("joins a started unawaited invocation before releasing an enclosing resource", async () => {
    const sandbox = new DeterministicSandboxProvider()
    let finish: (() => void) | undefined
    let started: (() => void) | undefined
    const active = new Promise<void>(resolve => {
      started = resolve
    })
    const tool = defineTool({
      description: "Finish later in the host",
      execute: async () => {
        started?.()
        await new Promise<void>(resolve => {
          finish = resolve
        })
        return "finished"
      },
      input: z.object({}),
      name: "host_lifecycle",
    })

    function Workflow() {
      void tool({})
      return "done"
    }

    const evaluation = new AmlRuntime().evaluate(
      <Sandbox provider={sandbox}>
        <Workflow />
      </Sandbox>
    )

    await active
    expect(sandbox.releases).toHaveLength(0)
    finish?.()
    await expect(evaluation).resolves.toBe("done")
    expect(sandbox.releases).toHaveLength(1)
  })
})
