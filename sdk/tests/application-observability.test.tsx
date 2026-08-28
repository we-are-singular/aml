import { describe, expect, it } from "vitest"

import { Parallel } from "../src/components/parallel/parallel.js"
import { AmlRuntime } from "../src/core/aml-runtime.js"
import { evaluate } from "../src/core/evaluate.js"
import { createTraceSummaryCollector } from "../src/observability/create-trace-summary-collector.js"
import type { AmlTraceEvent } from "../src/observability/trace-event.js"
import { withTraceSpan } from "../src/observability/with-trace-span.js"

describe("application observability", () => {
  it("nests application spans under components and concurrent lexical work", async () => {
    const events: AmlTraceEvent[] = []

    function Evaluated({ name }: { readonly name: string }) {
      return name
    }

    async function Lane({ name }: { readonly name: string }) {
      return await withTraceSpan(`${name}.outer`, async () => {
        const [nested, evaluated] = await Promise.all([
          withTraceSpan(`${name}.inner`, async () => withTraceSpan(`${name}.deep`, async () => name)),
          evaluate(<Evaluated name={name} />),
        ])
        return `${nested}${evaluated}`
      })
    }

    function Workflow() {
      return (
        <Parallel>
          <Lane name="first" />
          <Lane name="second" />
        </Parallel>
      )
    }

    await expect(new AmlRuntime({ trace: event => events.push(event) }).evaluate(<Workflow />)).resolves.toBe(
      "firstfirstsecondsecond"
    )

    const starts = events.filter(event => event.type === "span.start")
    for (const lane of ["first", "second"]) {
      const component = starts.find(
        event =>
          event.kind === "component" &&
          event.name === "Lane" &&
          starts.some(child => child.parentSpanId === event.spanId && child.name === `${lane}.outer`)
      )
      const outer = starts.find(event => event.kind === "application" && event.name === `${lane}.outer`)
      const inner = starts.find(event => event.kind === "application" && event.name === `${lane}.inner`)
      const deep = starts.find(event => event.kind === "application" && event.name === `${lane}.deep`)

      expect(outer?.parentSpanId).toBe(component?.spanId)
      expect(inner?.parentSpanId).toBe(outer?.spanId)
      expect(deep?.parentSpanId).toBe(inner?.spanId)
      expect(starts.some(event => event.name === "Evaluated" && event.parentSpanId === outer?.spanId)).toBe(true)
    }
  })

  it("closes application spans on success, thrown values, and cancellation", async () => {
    const events: AmlTraceEvent[] = []
    const controller = new AbortController()
    const thrown = { reason: "preserved" }

    async function Failure() {
      await withTraceSpan("successful", () => "ok")
      await withTraceSpan("failed", () => {
        throw thrown
      })
      return "unreachable"
    }

    await expect(new AmlRuntime({ trace: event => events.push(event) }).evaluate(<Failure />)).rejects.toBe(thrown)

    async function Cancelled() {
      return await withTraceSpan("cancelled", async () => {
        controller.abort(new Error("stop"))
        await Promise.resolve()
        return "late"
      })
    }

    await expect(
      new AmlRuntime({ trace: event => events.push(event) }).evaluate(<Cancelled />, { signal: controller.signal })
    ).rejects.toThrow("stop")

    expect(events.find(event => event.type === "span.end" && event.name === "successful")).toMatchObject({
      status: "ok",
    })
    expect(events.find(event => event.type === "span.end" && event.name === "failed")).toMatchObject({
      status: "error",
    })
    expect(events.find(event => event.type === "span.end" && event.name === "cancelled")).toMatchObject({
      status: "error",
    })
  })

  it("rejects calls outside an active component or after it settles", async () => {
    let detached: (() => void) | undefined

    function Workflow() {
      detached = () => void withTraceSpan("late", () => undefined)
      return "done"
    }

    expect(() => withTraceSpan("outside", () => undefined)).toThrow(
      "withTraceSpan() is only available while an AML component is active"
    )
    await new AmlRuntime().evaluate(<Workflow />)
    expect(detached).toThrow("withTraceSpan() is only available while an AML component is active")
  })

  it("isolates concurrent runtime evaluations and summarizes explicit run IDs", async () => {
    const summaries = createTraceSummaryCollector()
    const runtime = new AmlRuntime({ trace: summaries.trace })
    const runIds: string[] = []
    runtime.on("start", event => {
      runIds.push(event.runId)
    })

    async function Workflow({ name }: { readonly name: string }) {
      return await withTraceSpan(name, async () => name)
    }

    await Promise.all([runtime.evaluate(<Workflow name="first" />), runtime.evaluate(<Workflow name="second" />)])

    expect(runIds).toHaveLength(2)
    expect(runIds[0]).not.toBe(runIds[1])
    expect(summaries.forRun(runIds[0] ?? "")).toMatchObject({
      applicationSpans: { first: { count: 1 } },
      providerUsage: [],
      status: "ok",
    })
    expect(summaries.forRun(runIds[1] ?? "")).toMatchObject({
      applicationSpans: { second: { count: 1 } },
      providerUsage: [],
      status: "ok",
    })
  })

  it("keeps provider usage raw and cleanup separate from evaluation status", () => {
    const summaries = createTraceSummaryCollector()
    const base = { attributes: {}, runId: "run", timestamp: 1 }

    summaries.trace({
      ...base,
      attributes: { usage: '{"inputTokens":10,"outputTokens":4}' },
      durationMs: 3,
      kind: "agent",
      name: "agent.turn",
      parentSpanId: "session",
      sequence: 1,
      spanId: "turn",
      status: "ok",
      type: "span.end",
    })
    summaries.trace({
      ...base,
      durationMs: 1,
      kind: "agent",
      name: "agent.cleanup",
      parentSpanId: "session",
      sequence: 2,
      spanId: "cleanup",
      status: "error",
      type: "span.end",
    })
    summaries.trace({
      ...base,
      durationMs: 6,
      kind: "agent",
      name: "agent.session",
      parentSpanId: "agent",
      sequence: 3,
      spanId: "session",
      status: "error",
      type: "span.end",
    })
    summaries.trace({
      ...base,
      durationMs: 8,
      kind: "evaluation",
      name: "evaluate",
      sequence: 4,
      spanId: "root",
      status: "ok",
      type: "span.end",
    })

    expect(summaries.forRun("run")).toMatchObject({
      cleanup: [{ status: "error" }],
      providerUsage: ['{"inputTokens":10,"outputTokens":4}'],
      status: "ok",
    })
  })
})
