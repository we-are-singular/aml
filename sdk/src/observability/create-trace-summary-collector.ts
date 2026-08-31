import type { AmlTraceEvent, AmlTraceSpanEndEvent } from "./trace-event.js"
import type { TraceSink } from "./trace-sink.js"

interface ActiveTraceSummary {
  acpToolCallCount: number
  readonly acpToolCallsByName: Map<string, number>
  readonly spans: AmlTraceSpanEndEvent[]
}

/** Timing totals accumulated for one category of completed trace spans. */
interface TraceSpanAggregate {
  /** Number of matching completed spans observed in the evaluation. */
  readonly count: number

  /** Longest matching span duration; omitted when `count` is zero. */
  readonly slowestMs?: number

  /** Sum of all matching span durations in milliseconds. */
  readonly totalDurationMs: number
}

/** Result of one completed Agent cleanup span. */
interface TraceCleanupOutcome {
  /** Wall-clock duration of one Agent cleanup span in milliseconds. */
  readonly durationMs: number

  /** Whether that cleanup span completed without an error. */
  readonly status: "error" | "ok"
}

/**
 * Content-free measurements derived from one completed evaluation trace.
 *
 * Aggregates describe only AML and ACP boundaries present in the public trace;
 * they do not infer model calls, retries, cache behavior, cost, or billing.
 */
export interface TraceSummary {
  /** Provider-reported ACP tool-call starts, separate from AML `<Tool>` spans. */
  readonly acpToolCalls: {
    /** Counts keyed by the exact provider-reported capability name. */
    readonly byName: Readonly<Record<string, number>>

    /** Total initial ACP `tool_call` updates, including calls without a name. */
    readonly count: number
  }

  /** Provider session and authored-turn timing aggregates. */
  readonly agents: {
    /** Complete provider session boundaries, including setup and cleanup. */
    readonly sessions: TraceSpanAggregate

    /** Initial prompt and FollowUp provider request boundaries. */
    readonly turns: TraceSpanAggregate
  }

  /** Timing aggregates for each exact name passed to `withTraceSpan()`. */
  readonly applicationSpans: Readonly<Record<string, TraceSpanAggregate>>

  /** Ordered outcomes of Agent cleanup spans emitted during the evaluation. */
  readonly cleanup: readonly TraceCleanupOutcome[]

  /** Wall-clock duration of the root evaluation span in milliseconds. */
  readonly durationMs: number

  /**
   * Serialized provider-owned usage objects from successful Agent turns.
   *
   * An empty array means no usage was reported; entries promise no portable
   * token, model-call, cost, cache, or billing fields.
   */
  readonly providerUsage: readonly string[]

  /** Timing aggregates for resource and process execution boundaries. */
  readonly resources: {
    /** Completed Sandbox acquisition scopes. */
    readonly sandboxes: TraceSpanAggregate

    /** Completed Script executions. */
    readonly scripts: TraceSpanAggregate

    /** Completed Workspace materialization scopes. */
    readonly workspaces: TraceSpanAggregate
  }

  /** Opaque evaluation identifier used to retrieve and correlate this summary. */
  readonly runId: string

  /** Terminal status copied from the root evaluation span. */
  readonly status: "error" | "ok"

  /** Timing of declarative AML `<Tool>` executions, not provider-native tools. */
  readonly tools: TraceSpanAggregate
}

/** Run-keyed collector returned by {@link createTraceSummaryCollector}. */
interface TraceSummaryCollector {
  /**
   * Removes a retained completed summary.
   *
   * Returns `true` when a summary existed and was removed. Active, incomplete
   * run state is not affected.
   */
  deleteRun(runId: string): boolean

  /**
   * Returns the completed immutable summary for an explicit evaluation run.
   *
   * Returns `undefined` until the evaluation end event has been observed or
   * after the summary is deleted. There is intentionally no ambiguous
   * latest-run lookup for runtimes handling concurrent evaluations.
   */
  forRun(runId: string): TraceSummary | undefined

  /** Trace sink to register on `AmlRuntimeOptions.trace`. */
  readonly trace: TraceSink
}

/**
 * Creates an in-memory collector that derives content-free, run-keyed summaries
 * from public immutable trace events.
 *
 * Completed summaries remain retained until `deleteRun(runId)` is called. ACP
 * tool-call counts retain only initial call names and counts, never arguments,
 * results, prompts, or model text. One provider call routed to an AML `<Tool>`
 * may correctly appear in both `acpToolCalls` and `tools` because those measure
 * different boundaries.
 */
export function createTraceSummaryCollector(): TraceSummaryCollector {
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
    /** Removes one retained completed summary without touching active run state. */
    deleteRun(runId: string) {
      return completed.delete(runId)
    },
    /** Reads one completed summary by its explicit evaluation run id. */
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
