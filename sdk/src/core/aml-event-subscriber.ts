import type { AmlTraceEvent } from "../observability/trace-event.js"
import type { TraceSink } from "../observability/trace-sink.js"

/**
 * Announces that one runtime evaluation is ready to execute its AML tree.
 */
export interface AmlEvaluationStartEvent {
  /** Opaque identifier shared by every event from this evaluation. */
  readonly runId: string

  /** Evaluation-scoped signal that providers and listeners may observe. */
  readonly signal: AbortSignal
}

/**
 * Announces that one runtime evaluation has settled and is finishing cleanup.
 */
export interface AmlEvaluationFinishEvent {
  /** Failure that ended the evaluation; present only when `status` is `"error"`. */
  readonly error?: unknown

  /** Opaque identifier shared by every event from this evaluation. */
  readonly runId: string

  /** Evaluation-scoped signal, including any cancellation reason. */
  readonly signal: AbortSignal

  /** Whether AML evaluation and owned resource cleanup completed successfully. */
  readonly status: "error" | "ok"
}

/**
 * Maps every public runtime event to its immutable payload.
 */
export interface AmlEventMap {
  /** Payload emitted after evaluation and owned cleanup settle. */
  readonly finish: AmlEvaluationFinishEvent

  /** Payload emitted immediately before AML begins evaluating the authored tree. */
  readonly start: AmlEvaluationStartEvent

  /** Immutable observability event emitted during evaluation. */
  readonly trace: AmlTraceEvent
}

/** Names accepted by {@link AmlEventSubscriber.on} and `once`. */
export type AmlEventName = keyof AmlEventMap

/**
 * Defines the return contract for each runtime event.
 *
 * TraceSink carries the per-listener content policy. Awaiting remains a
 * dispatch decision: lifecycle listeners are awaited, while traces are not.
 */
export type AmlEventListener<Name extends AmlEventName> = Name extends "trace"
  ? TraceSink
  : (event: AmlEventMap[Name]) => Promise<void> | void

/**
 * Subscriber-only view of runtime events.
 *
 * Providers receive an evaluation-scoped implementation and cannot publish
 * events or observe concurrent evaluations through this boundary.
 */
export interface AmlEventSubscriber {
  /**
   * Registers a listener for every matching event in this evaluation scope.
   *
   * Returns an idempotent function that unregisters this exact listener.
   */
  on<Name extends AmlEventName>(name: Name, listener: AmlEventListener<Name>): () => void

  /**
   * Registers a listener that removes itself before its first matching event.
   *
   * Returns a function that can cancel the pending registration.
   */
  once<Name extends AmlEventName>(name: Name, listener: AmlEventListener<Name>): () => void
}
