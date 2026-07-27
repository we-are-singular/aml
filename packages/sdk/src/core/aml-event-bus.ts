import {
  createHooks,
  type HookCallback,
} from "hookable"

import { ComponentEvaluationContext } from "./component-evaluation-context.js"
import type {
  AmlEventListener,
  AmlEventMap,
  AmlEventName,
  AmlEventSubscriber,
  AmlEvaluationFinishEvent,
  AmlEvaluationStartEvent,
} from "./aml-event-subscriber.js"
import type { AmlTraceEvent } from "../observability/trace-event.js"

interface AmlHookMap {
  finish: AmlEventListener<"finish">
  start: AmlEventListener<"start">
  trace: AmlEventListener<"trace">
}

type TraceListenerErrorHandler = (
  error: unknown,
  event: AmlTraceEvent,
) => void

/**
 * Runtime-owned publisher for lifecycle and observability events.
 *
 * Hookable owns registration. This class owns AML's dispatch policies:
 * lifecycle listeners are awaited, while trace listeners begin immediately
 * and settle outside workflow control flow.
 */
export class AmlEventBus implements AmlEventSubscriber {
  readonly #hooks = createHooks<AmlHookMap>()

  /**
   * Registers one runtime-wide listener.
   */
  on<Name extends AmlEventName>(
    name: Name,
    listener: AmlEventListener<Name>,
  ): () => void {
    // Hookable cannot preserve the correlation between a generic event name
    // and its conditional listener type. The public signature enforces it.
    return this.#hooks.hook(name, listener as never)
  }

  /**
   * Registers one runtime-wide listener that removes itself before execution.
   */
  once<Name extends AmlEventName>(
    name: Name,
    listener: AmlEventListener<Name>,
  ): () => void {
    return this.#hooks.hookOnce(name, listener as never)
  }

  /**
   * Creates a subscriber that can observe only one evaluation.
   */
  scope(runId: string): AmlEventScope {
    return new AmlEventScope(this, runId)
  }

  /**
   * Awaits every start listener before evaluation enters user code.
   */
  async start(event: AmlEvaluationStartEvent): Promise<void> {
    await this.#hooks.callHookWith(
      async (listeners) =>
        await this.#callLifecycle(listeners, event, "start"),
      "start",
      [event],
    )
  }

  /**
   * Awaits every finish listener so all registered cleanup gets a chance.
   */
  async finish(event: AmlEvaluationFinishEvent): Promise<void> {
    await this.#hooks.callHookWith(
      async (listeners) =>
        await this.#callLifecycle(listeners, event, "finish"),
      "finish",
      [event],
    )
  }

  /**
   * Publishes one trace event without allowing observers to affect execution.
   */
  trace(
    event: AmlTraceEvent,
    onError: TraceListenerErrorHandler,
  ): void {
    try {
      const pending = ComponentEvaluationContext.withoutAccess(() =>
        this.#hooks.callHookParallel("trace", event),
      )

      // Observers begin synchronously, but AML never waits for their results.
      // Hookable consumes asynchronous handlers and reports rejection through
      // the existing out-of-band trace error channel.
      if (pending !== undefined) {
        void pending.catch((error: unknown) => {
          onError(error, event)
        })
      }
    } catch (error) {
      onError(error, event)
    }
  }

  /**
   * Calls awaited lifecycle listeners while preserving every failure.
   */
  async #callLifecycle(
    listeners: HookCallback[],
    event: AmlEvaluationFinishEvent | AmlEvaluationStartEvent,
    name: "finish" | "start",
  ): Promise<void> {
    const errors: unknown[] = []

    for (const listener of listeners) {
      try {
        await ComponentEvaluationContext.withoutAccess(
          async () =>
            await Reflect.apply(listener, undefined, [event]),
        )
      } catch (error) {
        errors.push(error)
      }
    }

    if (errors.length === 1) {
      throw errors[0]
    }

    if (errors.length > 1) {
      throw new AggregateError(
        errors,
        `AML ${name} listeners failed`,
      )
    }
  }
}

/**
 * Filters subscriptions to one run and releases them together at finish.
 */
class AmlEventScope implements AmlEventSubscriber {
  readonly #bus: AmlEventBus
  readonly #listeners = new Set<() => void>()
  readonly #runId: string
  #closed = false

  constructor(bus: AmlEventBus, runId: string) {
    this.#bus = bus
    this.#runId = runId
  }

  on<Name extends AmlEventName>(
    name: Name,
    listener: AmlEventListener<Name>,
  ): () => void {
    if (this.#closed) {
      throw new Error("AML evaluation event scope is closed")
    }

    const remove = this.#bus.on(name, ((event: AmlEventMap[Name]) => {
      if (event.runId === this.#runId) {
        return Reflect.apply(listener, undefined, [event])
      }
    }) as AmlEventListener<Name>)

    return this.#track(remove)
  }

  once<Name extends AmlEventName>(
    name: Name,
    listener: AmlEventListener<Name>,
  ): () => void {
    if (this.#closed) {
      throw new Error("AML evaluation event scope is closed")
    }

    let remove: () => void = () => undefined
    const removeListener = this.#bus.on(name, ((event: AmlEventMap[Name]) => {
      if (event.runId !== this.#runId) {
        return
      }

      remove()
      return Reflect.apply(listener, undefined, [event])
    }) as AmlEventListener<Name>)

    remove = this.#track(removeListener)
    return remove
  }

  /**
   * Removes every listener retained by the completed evaluation.
   */
  close(): void {
    if (this.#closed) {
      return
    }

    this.#closed = true

    for (const remove of [...this.#listeners]) {
      remove()
    }

    this.#listeners.clear()
  }

  /**
   * Makes one Hookable unregister callback idempotent within this scope.
   */
  #track(removeListener: () => void): () => void {
    let active = true

    const remove = () => {
      if (!active) {
        return
      }

      active = false
      this.#listeners.delete(remove)
      removeListener()
    }

    this.#listeners.add(remove)
    return remove
  }
}
