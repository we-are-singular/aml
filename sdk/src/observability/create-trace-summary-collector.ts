import type { AmlTraceSpanEndEvent } from "./trace-event.js"
import type { TraceSink } from "./trace-sink.js"

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
  const active = new Map<string, AmlTraceSpanEndEvent[]>()
  const completed = new Map<string, TraceSummary>()

  const trace: TraceSink = event => {
    if (event.type !== "span.end") return

    const spans = active.get(event.runId) ?? []
    spans.push(event)

    if (event.kind === "evaluation") {
      completed.set(event.runId, summarize(event, spans))
      active.delete(event.runId)
    } else {
      active.set(event.runId, spans)
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

function summarize(root: AmlTraceSpanEndEvent, spans: readonly AmlTraceSpanEndEvent[]): TraceSummary {
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
