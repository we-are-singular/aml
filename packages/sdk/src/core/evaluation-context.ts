import type { AmlTraceIdentity } from "./trace-identity.js"
import { AgentScheduler } from "./agent-scheduler.js"
import { EvaluationError } from "./evaluation-error.js"
import {
  TraceDispatcher,
  type TraceSpan,
} from "../observability/trace-dispatcher.js"
import type {
  AmlTraceAttribute,
  AmlTraceEventName,
  AmlTraceSpanKind,
} from "../observability/trace-event.js"
import type {
  TraceErrorHandler,
  TraceSink,
} from "../observability/trace-sink.js"

type TraceAttributes = Readonly<
  Record<string, AmlTraceAttribute>
>

/**
 * Owns cancellation and correlation identity for one complete evaluation.
 */
export class EvaluationContext {
  readonly #agentScheduler: AgentScheduler
  readonly #captureTraceContent: boolean
  readonly #maxAgentCalls: number
  readonly #maxStateTransitions: number
  readonly #runId = globalThis.crypto.randomUUID()
  readonly #signal: AbortSignal
  readonly #traceDispatcher: TraceDispatcher
  readonly #rootSpan: TraceSpan
  #agentCalls = 0
  #observationSpanSequence = 0
  #spanSequence = 0
  #stateTransitions = 0

  /**
   * Creates evaluation-owned counters around the caller's cancellation signal.
   */
  constructor(
    maxAgentCalls: number,
    maxConcurrentAgents: number,
    maxStateTransitions: number,
    signal: AbortSignal,
    trace: {
      readonly captureContent: boolean
      readonly onError: TraceErrorHandler | undefined
      readonly sink: TraceSink | undefined
    },
  ) {
    this.#agentScheduler = new AgentScheduler(
      maxConcurrentAgents,
      signal,
    )
    this.#maxAgentCalls = maxAgentCalls
    this.#maxStateTransitions = maxStateTransitions
    this.#signal = signal
    this.#captureTraceContent = trace.captureContent
    this.#traceDispatcher = new TraceDispatcher(
      trace.sink,
      trace.captureContent,
      trace.onError,
    )
    this.#rootSpan = this.#traceDispatcher.startSpan(
      this.#identity("trace-0"),
      "evaluation",
      "evaluate",
    )
  }

  /**
   * Exposes the one cancellation boundary shared by every nested operation.
   */
  get signal(): AbortSignal {
    return this.#signal
  }

  /**
   * Reports whether the configured sink explicitly accepts sensitive content.
   *
   * Producers use this before snapshotting Tool input or output so disabled
   * content tracing adds neither object traversal nor serialization work.
   */
  get capturesTraceContent(): boolean {
    return this.#captureTraceContent
  }

  /**
   * Returns the root identity inherited by top-level AML execution spans.
   */
  get rootTrace(): AmlTraceIdentity {
    return this.#rootSpan.identity
  }

  /**
   * Allocates a stable parent-aware identity for one execution boundary.
   */
  createTrace(parentSpanId?: string): AmlTraceIdentity {
    this.#spanSequence += 1

    return this.#identity(
      `span-${this.#spanSequence}`,
      parentSpanId,
    )
  }

  /**
   * Allocates instrumentation-only identity without shifting provider traces.
   */
  createObservationTrace(
    parentSpanId?: string,
  ): AmlTraceIdentity {
    this.#observationSpanSequence += 1

    return this.#identity(
      `trace-${this.#observationSpanSequence}`,
      parentSpanId,
    )
  }

  /**
   * Starts one immutable provider-neutral execution span.
   */
  startTraceSpan(
    trace: AmlTraceIdentity,
    kind: AmlTraceSpanKind,
    name: string,
    attributes: TraceAttributes = {},
    sensitiveAttributes: TraceAttributes = {},
  ): TraceSpan {
    return this.#traceDispatcher.startSpan(
      trace,
      kind,
      name,
      attributes,
      sensitiveAttributes,
    )
  }

  /**
   * Completes one trace span without exposing its mutable workflow owner.
   */
  endTraceSpan(
    span: TraceSpan,
    status: "error" | "ok",
    attributes: TraceAttributes = {},
    sensitiveAttributes: TraceAttributes = {},
  ): void {
    this.#traceDispatcher.endSpan(
      span,
      status,
      attributes,
      sensitiveAttributes,
    )
  }

  /**
   * Completes a failed span through the dispatcher's safe error snapshot.
   */
  failTraceSpan(span: TraceSpan, error: unknown): void {
    this.#traceDispatcher.failSpan(span, error)
  }

  /**
   * Emits one ordered fact inside an existing trace span.
   */
  traceEvent(
    trace: AmlTraceIdentity,
    name: AmlTraceEventName,
    attributes: TraceAttributes = {},
    sensitiveAttributes: TraceAttributes = {},
  ): void {
    this.#traceDispatcher.event(
      trace,
      name,
      attributes,
      sensitiveAttributes,
    )
  }

  /**
   * Reserves one provider call before it enters the scheduler.
   */
  reserveAgentCall(trace: AmlTraceIdentity): void {
    this.#signal.throwIfAborted()

    if (
      this.#maxAgentCalls !== 0 &&
      this.#agentCalls >= this.#maxAgentCalls
    ) {
      throw new EvaluationError(
        `AML evaluation exceeded maxAgentCalls ${this.#maxAgentCalls} at Agent ${trace.spanId}`,
      )
    }

    this.#agentCalls += 1
  }

  /**
   * Reserves one complete Loop commit across the evaluation domain.
   */
  reserveStateTransition(
    name: string,
    iteration: number,
    trace: AmlTraceIdentity,
  ): void {
    this.#signal.throwIfAborted()

    if (
      this.#maxStateTransitions !== 0 &&
      this.#stateTransitions >= this.#maxStateTransitions
    ) {
      throw new EvaluationError(
        `AML evaluation exceeded maxStateTransitions ${this.#maxStateTransitions} at Loop "${name}" iteration ${iteration}`,
      )
    }

    this.#stateTransitions += 1
    this.traceEvent(trace, "loop.transition", {
      iteration,
      name,
      transition: this.#stateTransitions,
    })
  }

  /**
   * Schedules one reserved provider call in this domain.
   */
  async scheduleAgent<Result>(
    operation: () => PromiseLike<Result> | Result,
  ): Promise<Result> {
    return await this.#agentScheduler.run(operation)
  }

  /**
   * Releases scheduler listeners after every nested evaluation has settled.
   */
  close(failed: boolean, error?: unknown): void {
    this.#agentScheduler.close()
    if (failed) {
      this.#traceDispatcher.failSpan(this.#rootSpan, error)
    } else {
      this.#traceDispatcher.endSpan(this.#rootSpan, "ok")
    }

    this.#traceDispatcher.close()
  }

  /**
   * Creates one frozen identity without exposing the evaluation sequence.
   */
  #identity(
    spanId: string,
    parentSpanId?: string,
  ): AmlTraceIdentity {
    return Object.freeze({
      ...(parentSpanId === undefined ? {} : { parentSpanId }),
      runId: this.#runId,
      spanId,
    })
  }
}
