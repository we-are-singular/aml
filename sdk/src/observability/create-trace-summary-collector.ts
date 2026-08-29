import type { AmlTraceEvent, AmlTraceSpanEndEvent } from "./trace-event.js"
import type { TraceSink } from "./trace-sink.js"

interface ActiveTraceSummary {
  acpToolCallCount: number
  readonly acpToolCallsByName: Map<string, number>
  readonly spans: AmlTraceSpanEndEvent[]
}

interface TraceSpanAggregate {
  readonly count: number
  readonly slowestMs?: number
  readonly totalDurationMs: number
}

interface TraceCleanupOutcome {
  readonly durationMs: number
  readonly status: "error" | "ok"
}

/** Content-free measurements derived from one completed evaluation trace. */
export interface TraceSummary {
  readonly acpToolCalls: {
    readonly byName: Readonly<Record<string, number>>
    readonly count: number
  }
  readonly agents: {
    readonly sessions: TraceSpanAggregate
    readonly turns: TraceSpanAggregate
  }
  readonly applicationSpans: Readonly<Record<string, TraceSpanAggregate>>
  readonly cleanup: readonly TraceCleanupOutcome[]
  readonly durationMs: number
  readonly providerUsage: readonly string[]
  readonly resources: {
    readonly sandboxes: TraceSpanAggregate
    readonly scripts: TraceSpanAggregate
    readonly workspaces: TraceSpanAggregate
  }
  readonly runId: string
  readonly status: "error" | "ok"
  readonly tools: TraceSpanAggregate
}

/** Derives run-keyed summaries from public immutable trace events. */
export function createTraceSummaryCollector() {
  const active = new Map<string, ActiveTraceSummary>()
  const completed = new Map<string, TraceSummary>()

  const trace: TraceSink = event => {
    if (isAcpToolCall(event)) {
      const summary = active.get(event.runId) ?? createActiveTraceSummary()
      summary.acpToolCallCount += 1

      const toolName = event.attributes.toolName
      if (typeof toolName === "string") {
        summary.acpToolCallsByName.set(toolName, (summary.acpToolCallsByName.get(toolName) ?? 0) + 1)
      }

      active.set(event.runId, summary)
      return
    }

    if (event.type !== "span.end") return

    const summary = active.get(event.runId) ?? createActiveTraceSummary()
    summary.spans.push(event)

    if (event.kind === "evaluation") {
      completed.set(event.runId, summarize(event, summary))
      active.delete(event.runId)
    } else {
      active.set(event.runId, summary)
    }
  }

  return Object.freeze({
    deleteRun(runId: string) {
      return completed.delete(runId)
    },
    forRun(runId: string) {
      return completed.get(runId)
    },
    trace,
  })
}

function createActiveTraceSummary(): ActiveTraceSummary {
  return { acpToolCallCount: 0, acpToolCallsByName: new Map(), spans: [] }
}

function isAcpToolCall(event: AmlTraceEvent): boolean {
  return event.type === "event" && event.name === "acp.session.update" && event.attributes.sessionUpdate === "tool_call"
}

function summarize(root: AmlTraceSpanEndEvent, summary: ActiveTraceSummary): TraceSummary {
  const { spans } = summary
  const applicationNames = new Set(spans.filter(span => span.kind === "application").map(span => span.name))
  const applicationSpans = Object.fromEntries(
    [...applicationNames].map(name => [
      name,
      aggregate(spans.filter(span => span.kind === "application" && span.name === name)),
    ])
  )

  const agentSpans = spans.filter(span => span.kind === "agent")
  const turns = agentSpans.filter(span => span.name === "agent.turn")

  return Object.freeze({
    acpToolCalls: Object.freeze({
      byName: Object.freeze(Object.fromEntries(summary.acpToolCallsByName)),
      count: summary.acpToolCallCount,
    }),
    agents: Object.freeze({
      sessions: aggregate(agentSpans.filter(span => span.name === "agent.session")),
      turns: aggregate(turns),
    }),
    applicationSpans: Object.freeze(applicationSpans),
    cleanup: Object.freeze(
      agentSpans
        .filter(span => span.name === "agent.cleanup")
        .map(span => Object.freeze({ durationMs: span.durationMs, status: span.status }))
    ),
    durationMs: root.durationMs,
    providerUsage: Object.freeze(
      turns.flatMap(span => (typeof span.attributes.usage === "string" ? [span.attributes.usage] : []))
    ),
    resources: Object.freeze({
      sandboxes: aggregate(spans.filter(span => span.kind === "sandbox")),
      scripts: aggregate(spans.filter(span => span.kind === "script")),
      workspaces: aggregate(spans.filter(span => span.kind === "workspace")),
    }),
    runId: root.runId,
    status: root.status,
    tools: aggregate(spans.filter(span => span.kind === "tool")),
  })
}

function aggregate(spans: readonly AmlTraceSpanEndEvent[]): TraceSpanAggregate {
  const totalDurationMs = spans.reduce((total, span) => total + span.durationMs, 0)
  return Object.freeze({
    count: spans.length,
    ...(spans.length === 0 ? {} : { slowestMs: Math.max(...spans.map(span => span.durationMs)) }),
    totalDurationMs,
  })
}
