import { AmlEventBus } from "./aml-event-bus.js"
import type {
  AmlEventListener,
  AmlEventName,
  AmlEventSubscriber,
  AmlEvaluationFinishEvent,
  AmlEvaluationStartEvent,
} from "./aml-event-subscriber.js"
import type { AmlTraceEvent } from "../observability/trace-event.js"
import type { TraceErrorHandler } from "../observability/trace-sink.js"

/**
 * Publishes to runtime listeners and one evaluation-local Hookable registry.
 */
export class AmlEventScope implements AmlEventSubscriber {
  readonly #local = new AmlEventBus()
  readonly #runtime: AmlEventBus
  #closed = false

  constructor(runtime: AmlEventBus) {
    this.#runtime = runtime
  }

  /**
   * Reports whether any observer of this evaluation accepts trace content.
   */
  get capturesTraceContent(): boolean {
    return (
      this.#runtime.capturesTraceContent ||
      this.#local.capturesTraceContent
    )
  }

  /**
   * Registers one listener visible only to this evaluation.
   */
  on<Name extends AmlEventName>(
    name: Name,
    listener: AmlEventListener<Name>,
  ): () => void {
    this.#assertOpen()
    return this.#local.on(name, listener)
  }

  /**
   * Registers one evaluation-local listener for its next event.
   */
  once<Name extends AmlEventName>(
    name: Name,
    listener: AmlEventListener<Name>,
  ): () => void {
    this.#assertOpen()
    return this.#local.once(name, listener)
  }

  /**
   * Runs runtime setup before any evaluation-local setup registered in time.
   */
  async start(event: AmlEvaluationStartEvent): Promise<void> {
    await this.#runtime.start(event)
    await this.#local.start(event)
  }

  /**
   * Gives both runtime and evaluation cleanup listeners a chance to settle.
   */
  async finish(event: AmlEvaluationFinishEvent): Promise<void> {
    const errors: unknown[] = []

    // The two registries are independent failure boundaries. A defect in one
    // must not prevent the other registry's cleanup listeners from running.
    for (const events of [this.#runtime, this.#local]) {
      try {
        errors.push(...(await events.finish(event)))
      } catch (error) {
        errors.push(error)
      }
    }

    if (errors.length === 1) {
      throw errors[0]
    }

    if (errors.length > 1) {
      throw new AggregateError(errors, "AML finish listeners failed")
    }
  }

  /**
   * Delivers one trace event to runtime and evaluation-local observers.
   */
  trace(
    redacted: AmlTraceEvent,
    content: AmlTraceEvent,
    onError: TraceErrorHandler,
  ): void {
    this.#runtime.trace(redacted, content, onError)
    this.#local.trace(redacted, content, onError)
  }

  /**
   * Drops the complete local registry when its evaluation finishes.
   */
  close(): void {
    if (this.#closed) {
      return
    }

    this.#closed = true
    this.#local.close()
  }

  /**
   * Rejects provider registrations after their evaluation boundary closed.
   */
  #assertOpen(): void {
    if (this.#closed) {
      throw new Error("AML evaluation event scope is closed")
    }
  }
}
