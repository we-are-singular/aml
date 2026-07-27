import type { AmlTraceIdentity } from "./trace-identity.js"
import { AmlEventBus } from "./aml-event-bus.js"
import { AmlEventScope } from "./aml-event-scope.js"
import type { AmlEventSubscriber } from "./aml-event-subscriber.js"
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
} from "../observability/trace-sink.js"

type TraceAttributes = Readonly<
  Record<string, AmlTraceAttribute>
>

/**
 * Owns cancellation and correlation identity for one complete evaluation.
 */
export class EvaluationContext {
  readonly #agentScheduler: AgentScheduler
  readonly #eventScope: AmlEventScope
  readonly #maxAgentCalls: number
  readonly #maxStateTransitions: number
  readonly #runId = globalThis.crypto.randomUUID()
  readonly #signal: AbortSignal
  readonly #traceDispatcher: TraceDispatcher
  #rootSpan: TraceSpan | undefined
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
    events: AmlEventBus,
    trace: {
      readonly onError: TraceErrorHandler | undefined
    },
  ) {
    this.#agentScheduler = new AgentScheduler(
      maxConcurrentAgents,
      signal,
    )
    this.#maxAgentCalls = maxAgentCalls
    this.#maxStateTransitions = maxStateTransitions
    this.#signal = signal
    this.#eventScope = new AmlEventScope(events)
    this.#traceDispatcher = new TraceDispatcher(
      this.#eventScope,
      trace.onError,
    )
  }

  /**
   * Exposes the one cancellation boundary shared by every nested operation.
   */
  get signal(): AbortSignal {
    return this.#signal
  }

  /**
   * Exposes registration without giving providers event publication authority.
   */
  get events(): AmlEventSubscriber {
    return this.#eventScope
  }

  /**
   * Reports whether an observer of this evaluation accepts sensitive content.
   *
   * Producers use this before snapshotting Tool input or output so disabled
   * content tracing adds neither object traversal nor serialization work.
   */
  get capturesTraceContent(): boolean {
    return this.#eventScope.capturesTraceContent
  }

  /**
   * Returns the root identity inherited by top-level AML execution spans.
   */
  get rootTrace(): AmlTraceIdentity {
    if (this.#rootSpan === undefined) {
      throw new EvaluationError("AML evaluation has not started")
    }

    return this.#rootSpan.identity
  }

  /**
   * Runs runtime-wide setup before AML enters the authored tree.
   */
  async start(): Promise<void> {
    await this.#eventScope.start(
      Object.freeze({
        runId: this.#runId,
        signal: this.#signal,
      }),
    )
    this.#signal.throwIfAborted()
    this.#rootSpan = this.#traceDispatcher.startSpan(
      this.#identity("trace-0"),
      "evaluation",
      "evaluate",
    )
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
   * Runs finish listeners and closes tracing after evaluation settles.
   */
  async close(failed: boolean, error?: unknown): Promise<void> {
    this.#agentScheduler.close()

    let finishError: unknown
    let finishFailed = false

    try {
      await this.#eventScope.finish(
        Object.freeze({
          ...(failed ? { error } : {}),
          runId: this.#runId,
          signal: this.#signal,
          status: failed ? "error" : "ok",
        }),
      )
    } catch (listenerError) {
      finishFailed = true
      finishError = listenerError
    }

    let terminalError = error

    if (failed && finishFailed) {
      terminalError = new AggregateError(
        [error, finishError],
        "AML evaluation and finish listeners both failed",
      )
    } else if (finishFailed) {
      terminalError = finishError
    }

    // A failed start hook has no execution trace to close.
    if (this.#rootSpan !== undefined) {
      if (failed || finishFailed) {
        this.#traceDispatcher.failSpan(
          this.#rootSpan,
          terminalError,
        )
      } else {
        this.#traceDispatcher.endSpan(this.#rootSpan, "ok")
      }
    }

    this.#traceDispatcher.close()
    this.#eventScope.close()

    if (finishFailed) {
      throw terminalError
    }
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
