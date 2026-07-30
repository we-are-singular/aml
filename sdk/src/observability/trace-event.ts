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
 */
export type AmlTraceSpanKind =
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
 */
export type AmlTraceEventName = "agent.turn" | "capability.mcp" | "capability.tool" | "loop.transition"

/**
 * Common immutable correlation and ordering fields on every trace event.
 */
export interface AmlTraceEventBase extends AmlTraceIdentity {
  readonly attributes: Readonly<Record<string, AmlTraceAttribute>>
  readonly sequence: number
  readonly timestamp: number
}

/**
 * Announces the start of one attributable execution boundary.
 */
export interface AmlTraceSpanStartEvent extends AmlTraceEventBase {
  readonly kind: AmlTraceSpanKind
  readonly name: string
  readonly type: "span.start"
}

/**
 * Closes one execution boundary using the identity from its start event.
 */
export interface AmlTraceSpanEndEvent extends AmlTraceEventBase {
  readonly durationMs: number
  readonly kind: AmlTraceSpanKind
  readonly name: string
  readonly status: "error" | "ok"
  readonly type: "span.end"
}

/**
 * Records one ordered fact inside an existing execution boundary.
 */
export interface AmlTracePointEvent extends AmlTraceEventBase {
  readonly name: AmlTraceEventName
  readonly type: "event"
}

/**
 * Stable provider-neutral event union emitted by one AML evaluation.
 */
export type AmlTraceEvent = AmlTracePointEvent | AmlTraceSpanEndEvent | AmlTraceSpanStartEvent
