import type { AmlTraceIdentity } from "../core/trace-identity.js"

/**
 * Immutable scalar metadata accepted by AML's stable trace contract.
 *
 * Trace attributes intentionally exclude arbitrary objects so observers never
 * receive live workflow, provider, Tool, or resource references.
 */
export type AmlTraceAttribute = boolean | number | string | readonly string[]

/**
 * Execution boundaries represented by paired start and end events.
 *
 * `application` is user-defined work measured by `withTraceSpan()`. The other
 * values identify runtime evaluation, authored component, provider, capability,
 * and resource boundaries owned by AML.
 */
export type AmlTraceSpanKind =
  | "application"
  | "evaluation"
  | "component"
  | "agent"
  | "file"
  | "system"
  | "skill"
  | "tool"
  | "loop"
  | "sandbox"
  | "script"
  | "workspace"

/**
 * Point-in-time events that belong to an existing execution span.
 *
 * ACP names report facts observed at the Agent Client Protocol boundary.
 * `agent.output` reports structured-result submissions, `capability.*` reports
 * grants, `loop.transition` reports committed state, and `sandbox.process`
 * reports process lifecycle observations. Event-specific details are carried in
 * `attributes`; consumers must tolerate new attributes over time.
 */
export type AmlTraceEventName =
  | "acp.session.cancel"
  | "acp.session.created"
  | "acp.session.prompt.completed"
  | "acp.session.prompt.submitted"
  | "acp.session.update"
  | "agent.output"
  | "agent.session"
  | "capability.mcp"
  | "capability.tool"
  | "loop.transition"
  | "sandbox.process"

/**
 * Common immutable correlation and ordering fields on every trace event.
 */
export interface AmlTraceEventBase extends AmlTraceIdentity {
  /**
   * Frozen provider-neutral metadata for this event.
   *
   * Sensitive values such as prompts, output, and error messages are omitted
   * unless the receiving {@link TraceSink} enables content capture.
   */
  readonly attributes: Readonly<Record<string, AmlTraceAttribute>>

  /** Monotonically increasing event order within `runId`, starting at one. */
  readonly sequence: number

  /** Event creation time as Unix epoch milliseconds from `Date.now()`. */
  readonly timestamp: number
}

/**
 * Announces the start of one attributable execution boundary.
 */
export interface AmlTraceSpanStartEvent extends AmlTraceEventBase {
  /** Stable category of the execution boundary being opened. */
  readonly kind: AmlTraceSpanKind

  /** Boundary name; built-in names are stable and application names are caller-owned. */
  readonly name: string

  /** Discriminant identifying the opening half of a span. */
  readonly type: "span.start"
}

/**
 * Closes one execution boundary using the identity from its start event.
 */
export interface AmlTraceSpanEndEvent extends AmlTraceEventBase {
  /** Elapsed wall-clock duration of the span in milliseconds. */
  readonly durationMs: number

  /** Stable category copied from the matching start event. */
  readonly kind: AmlTraceSpanKind

  /** Boundary name copied from the matching start event. */
  readonly name: string

  /** Whether the boundary completed normally or ended with an error. */
  readonly status: "error" | "ok"

  /** Discriminant identifying the closing half of a span. */
  readonly type: "span.end"
}

/**
 * Records one ordered fact inside an existing execution boundary.
 */
export interface AmlTracePointEvent extends AmlTraceEventBase {
  /** Stable name describing the fact recorded by this event. */
  readonly name: AmlTraceEventName

  /** Discriminant identifying an instantaneous event rather than a span edge. */
  readonly type: "event"
}

/**
 * Stable provider-neutral event union emitted by one AML evaluation.
 *
 * Narrow on `type` before reading span-only fields, then use `kind` or `name`
 * for boundary-specific handling. Consumers should order events by `sequence`,
 * not timestamp, and correlate spans through `spanId` and `parentSpanId`.
 */
export type AmlTraceEvent = AmlTracePointEvent | AmlTraceSpanEndEvent | AmlTraceSpanStartEvent
