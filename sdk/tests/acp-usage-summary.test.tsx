import { agent, methods, ndJsonStream, type PromptResponse } from "@agentclientprotocol/sdk"
import { describe, expect, it } from "vitest"
import { z } from "zod"

import { AbstractAgentProvider } from "../src/components/agent/abstract-agent-provider.js"
import { openAcpSession } from "../src/components/agent/acp-agent-session.js"
import type { AgentExecutionContext } from "../src/components/agent/agent-execution-context.js"
import { agentObservabilityServices } from "../src/components/agent/agent-observability-services.js"
import type { AgentProviderSession } from "../src/components/agent/agent-provider-session.js"
import type { AgentRequest } from "../src/components/agent/agent-request.js"
import { Agent } from "../src/components/agent/agent.js"
import { FollowUp } from "../src/components/follow-up/follow-up.js"
import { Parallel } from "../src/components/parallel/parallel.js"
import { AmlRuntime } from "../src/core/aml-runtime.js"
import { createTraceSummaryCollector } from "../src/observability/create-trace-summary-collector.js"
import type { AmlTraceEvent } from "../src/observability/trace-event.js"

describe("ACP prompt usage summaries", () => {
  it.each(["distinct", "identical", "missing initial", "missing repair", "missing both"])(
    "preserves raw prompt samples in one structured repair turn: %s",
    async scenario => {
      const initial = { inputTokens: 100, outputTokens: 10, totalTokens: 110 }
      const repair = { inputTokens: 200, outputTokens: 20, totalTokens: 220, _meta: { provider: { cacheHits: 3 } } }
      const usages = [
        scenario === "missing initial" || scenario === "missing both" ? undefined : initial,
        scenario === "missing repair" || scenario === "missing both"
          ? undefined
          : scenario === "identical"
            ? initial
            : repair,
      ]
      const provider = new UsageAcpProvider((index, submit) => {
        if (index === 1) submit({ proof: "accepted" })
        const usage = usages[index]
        return { stopReason: "end_turn", ...(usage === undefined ? {} : { usage }) }
      })
      const summaries = createTraceSummaryCollector()
      const events: AmlTraceEvent[] = []
      const runtime = new AmlRuntime({ trace: summaries.trace })
      runtime.on("trace", event => events.push(event))

      await runtime.evaluate(
        <Agent provider={provider} schema={z.object({ proof: z.string() })}>
          PRIVATE_PROMPT
        </Agent>
      )

      const completions = events.filter(
        event => event.type === "event" && event.name === "acp.session.prompt.completed"
      )
      expect(completions).toHaveLength(2)
      expect(new Set(completions.map(event => event.spanId)).size).toBe(1)
      expect(summaries.forRun(events[0]?.runId ?? "")).toMatchObject({
        agents: { sessions: { count: 1 }, turns: { count: 1 } },
        providerUsage: usages.flatMap(usage => (usage === undefined ? [] : [JSON.stringify(usage)])),
        status: "ok",
      })
      expect(JSON.stringify(events)).not.toContain("PRIVATE_PROMPT")
    }
  )

  it("does not double ordinary usage repeated on the completion event and turn span", async () => {
    const usage = { inputTokens: 100, outputTokens: 10, totalTokens: 110 }
    const provider = new UsageAcpProvider(() => ({ stopReason: "end_turn", usage }))
    const summaries = createTraceSummaryCollector()
    const events: AmlTraceEvent[] = []
    const runtime = new AmlRuntime({ trace: summaries.trace })
    runtime.on("trace", event => events.push(event))

    await runtime.evaluate(<Agent provider={provider}>prompt</Agent>)

    expect(events.filter(event => event.attributes.usage === JSON.stringify(usage))).toHaveLength(2)
    expect(summaries.forRun(events[0]?.runId ?? "")).toMatchObject({
      agents: { turns: { count: 1 } },
      providerUsage: [JSON.stringify(usage)],
    })
  })

  it.each(["failed", "cancelled", "missing output"])("retains completed usage when the repair is %s", async outcome => {
    const initial = { inputTokens: 100, outputTokens: 10, totalTokens: 110 }
    const repair = { inputTokens: 200, outputTokens: 20, totalTokens: 220 }
    const controller = new AbortController()
    let markRepairStarted: () => void = () => undefined
    const repairStarted = new Promise<void>(resolve => {
      markRepairStarted = resolve
    })
    const provider = new UsageAcpProvider(async (index, _submit, context) => {
      if (index === 0) return { stopReason: "end_turn", usage: initial }
      markRepairStarted()
      if (outcome === "failed") throw new Error("repair failed")
      if (outcome === "cancelled") {
        return await new Promise<never>((_resolve, reject) => {
          context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true })
        })
      }
      return { stopReason: "end_turn", usage: repair }
    })
    const summaries = createTraceSummaryCollector()
    const events: AmlTraceEvent[] = []
    const runtime = new AmlRuntime({ trace: summaries.trace })
    runtime.on("trace", event => events.push(event))
    const pending = runtime.evaluate(
      <Agent provider={provider} schema={z.object({ proof: z.string() })}>
        prompt
      </Agent>,
      { signal: controller.signal }
    )
    const rejected = expect(pending).rejects.toMatchObject({
      cause:
        outcome === "failed"
          ? { data: { details: "repair failed" } }
          : {
              message: expect.stringContaining(
                outcome === "missing output" ? "did not submit a valid structured result" : "repair cancelled"
              ),
            },
    })

    await repairStarted
    if (outcome === "cancelled") controller.abort(new Error("repair cancelled"))
    await rejected

    expect(summaries.forRun(events[0]?.runId ?? "")).toMatchObject({
      agents: { sessions: { count: 1 }, turns: { count: 1 } },
      providerUsage: (outcome === "missing output" ? [initial, repair] : [initial]).map(usage => JSON.stringify(usage)),
      status: "error",
    })
  })

  it("isolates concurrent evaluations, Agent sessions, and authored follow-up turns", async () => {
    const summaries = createTraceSummaryCollector()
    const events: AmlTraceEvent[] = []
    const runtime = new AmlRuntime({ trace: summaries.trace })
    runtime.on("trace", event => events.push(event))
    let markAllStarted: () => void = () => undefined
    const allStarted = new Promise<void>(resolve => {
      markAllStarted = resolve
    })
    let started = 0

    function Workflow({ base }: { readonly base: number }) {
      return (
        <Parallel>
          {[base, base + 10].map(inputTokens => (
            <Agent
              provider={
                new UsageAcpProvider(async (index, submit) => {
                  if (index === 0) {
                    if (++started === 4) markAllStarted()
                    await allStarted
                  }
                  if (index === 2) submit({ proof: "accepted" })
                  return {
                    stopReason: "end_turn",
                    usage: { inputTokens: inputTokens + index, outputTokens: 1, totalTokens: inputTokens + index + 1 },
                  }
                })
              }
              schema={z.object({ proof: z.string() })}
            >
              initial
              <FollowUp>submit</FollowUp>
            </Agent>
          ))}
        </Parallel>
      )
    }

    const runIds: string[] = []
    runtime.on("start", event => {
      runIds.push(event.runId)
    })
    await Promise.all([runtime.evaluate(<Workflow base={100} />), runtime.evaluate(<Workflow base={200} />)])

    expect(runIds).toHaveLength(2)
    for (const [index, runId] of runIds.entries()) {
      const summary = summaries.forRun(runId)
      const base = (index + 1) * 100
      expect(summary).toMatchObject({ agents: { sessions: { count: 2 }, turns: { count: 4 } }, status: "ok" })
      expect(summary?.providerUsage.map(raw => JSON.parse(raw).inputTokens).sort((a, b) => a - b)).toEqual([
        base,
        base + 1,
        base + 2,
        base + 10,
        base + 11,
        base + 12,
      ])
      const completions = events.filter(
        event => event.runId === runId && event.type === "event" && event.name === "acp.session.prompt.completed"
      )
      expect(completions).toHaveLength(6)
      expect(new Set(completions.map(event => event.spanId)).size).toBe(4)
    }
  })
})

type PromptHandler = (
  index: number,
  submit: (value: unknown) => void,
  context: AgentExecutionContext
) => PromptResponse | Promise<PromptResponse>

/** Runs the real ACP repair lifecycle over an in-memory protocol connection. */
class UsageAcpProvider extends AbstractAgentProvider<"usage-acp"> {
  readonly #onPrompt: PromptHandler

  constructor(onPrompt: PromptHandler) {
    super("usage-acp")
    this.#onPrompt = onPrompt
  }

  protected async openSession(_request: AgentRequest, context: AgentExecutionContext): Promise<AgentProviderSession> {
    const clientToAgent = new TransformStream<Uint8Array, Uint8Array>()
    const agentToClient = new TransformStream<Uint8Array, Uint8Array>()
    let markExited: () => void = () => undefined
    const exited = new Promise<void>(resolve => {
      markExited = resolve
    })
    let index = 0
    let structured: unknown
    const app = agent({ name: "usage-acp" })
      .onRequest(methods.agent.initialize, ({ params }) => ({ protocolVersion: params.protocolVersion }))
      .onRequest(methods.agent.session.new, () => ({ sessionId: "usage-session" }))
      .onRequest(methods.agent.session.prompt, () =>
        this.#onPrompt(
          index++,
          value => {
            structured = value
          },
          context
        )
      )
    const connection = app.connect(ndJsonStream(agentToClient.writable, clientToAgent.readable))

    return await openAcpSession({
      cwd: "/workspace",
      observability: agentObservabilityServices(context),
      process: {
        id: "usage-process",
        async kill() {
          connection.close()
          markExited()
        },
        stdin: clientToAgent.writable,
        stderr: new ReadableStream({ start: controller => controller.close() }),
        stdout: agentToClient.readable,
        async wait() {
          await exited
          return { exitCode: 0 }
        },
      },
      signal: context.signal,
      structuredOutput: {
        instruction: "Call aml_submit_result.",
        beginStructuredTurn() {
          structured = undefined
        },
        hasStructuredResult: () => structured !== undefined,
        structuredResult() {
          if (structured === undefined) throw new Error("ACP Agent did not submit a valid structured result")
          return structured
        },
      },
    })
  }
}
