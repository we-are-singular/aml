import type { AmlTraceEvent } from "../observability/trace-event.js"
import type { TraceSink } from "../observability/trace-sink.js"

/**
 * Announces that one runtime evaluation is ready to execute its AML tree.
 */
export interface AmlEvaluationStartEvent {
  readonly runId: string
  readonly signal: AbortSignal
}

/**
 * Announces that one runtime evaluation has settled and is finishing cleanup.
 */
export interface AmlEvaluationFinishEvent {
  readonly error?: unknown
  readonly runId: string
  readonly signal: AbortSignal
  readonly status: "error" | "ok"
}

/**
 * Maps every public runtime event to its immutable payload.
 */
export interface AmlEventMap {
  readonly finish: AmlEvaluationFinishEvent
  readonly start: AmlEvaluationStartEvent
  readonly trace: AmlTraceEvent
}

export type AmlEventName = keyof AmlEventMap

/**
 * Defines the return contract for each runtime event.
 *
 * TraceSink carries the per-listener content policy. Awaiting remains a
 * dispatch decision: lifecycle listeners are awaited, while traces are not.
 */
export type AmlEventListener<Name extends AmlEventName> =
  Name extends "trace"
    ? TraceSink
    : (event: AmlEventMap[Name]) => Promise<void> | void

/**
 * Subscriber-only view of runtime events.
 *
 * Providers receive an evaluation-scoped implementation and cannot publish
 * events or observe concurrent evaluations through this boundary.
 */
export interface AmlEventSubscriber {
  on<Name extends AmlEventName>(
    name: Name,
    listener: AmlEventListener<Name>,
  ): () => void

  once<Name extends AmlEventName>(
    name: Name,
    listener: AmlEventListener<Name>,
  ): () => void
}
