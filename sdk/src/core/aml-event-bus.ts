import { createHooks } from "hookable"

import { ComponentEvaluationContext } from "./component-evaluation-context.js"
import type {
  AmlEventListener,
  AmlEventName,
  AmlEventSubscriber,
  AmlEvaluationFinishEvent,
  AmlEvaluationStartEvent,
} from "./aml-event-subscriber.js"
import type { AmlTraceEvent } from "../observability/trace-event.js"
import type {
  TraceErrorHandler,
  TraceSink,
} from "../observability/trace-sink.js"

interface AmlTraceEnvelope {
  readonly content: AmlTraceEvent
  readonly redacted: AmlTraceEvent
}

interface AmlHookMap {
  finish: AmlEventListener<"finish">
  start: AmlEventListener<"start">
  trace: (events: AmlTraceEnvelope) => Promise<void> | void
}

/**
 * Owns one Hookable registry and AML's event dispatch policies.
 *
 * A runtime and each active evaluation use separate instances. This keeps
 * evaluation-scoped subscribers out of unrelated concurrent dispatches.
 */
export class AmlEventBus implements AmlEventSubscriber {
  readonly #hooks = createHooks<AmlHookMap>()
  readonly #contentTraceListeners = new Set<symbol>()

  /**
   * Reports whether this registry has a trace listener that accepts content.
   */
  get capturesTraceContent(): boolean {
    return this.#contentTraceListeners.size > 0
  }

  /**
   * Registers one listener until its returned unsubscribe function is called.
   */
  on<Name extends AmlEventName>(
    name: Name,
    listener: AmlEventListener<Name>,
  ): () => void {
    return this.#register(name, listener, false)
  }

  /**
   * Registers one listener that removes itself before its first invocation.
   */
  once<Name extends AmlEventName>(
    name: Name,
    listener: AmlEventListener<Name>,
  ): () => void {
    return this.#register(name, listener, true)
  }

  /**
   * Runs setup listeners serially and stops at the first failure.
   */
  async start(event: AmlEvaluationStartEvent): Promise<void> {
    await ComponentEvaluationContext.withoutAccess(
      async () => await this.#hooks.callHook("start", event),
    )
  }

  /**
   * Runs every cleanup listener and returns each failure in call order.
   */
  async finish(
    event: AmlEvaluationFinishEvent,
  ): Promise<readonly unknown[]> {
    return await this.#hooks.callHookWith(
      async (listeners) => {
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

        return errors
      },
      "finish",
      [event],
    )
  }

  /**
   * Starts every trace listener without awaiting or coupling their failures.
   */
  trace(
    redacted: AmlTraceEvent,
    content: AmlTraceEvent,
    onError: TraceErrorHandler,
  ): void {
    const envelope = Object.freeze({ content, redacted })

    this.#hooks.callHookWith(
      (listeners) => {
        for (const listener of listeners) {
          let result: unknown

          try {
            // Invoke each observer separately so a synchronous throw cannot
            // abort Hookable's listener traversal.
            result = ComponentEvaluationContext.withoutAccess(() =>
              Reflect.apply(listener, undefined, [envelope]),
            )
          } catch (error) {
            onError(error, redacted)
            continue
          }

          // Promise.resolve also adopts custom thenables. AML deliberately
          // observes rejection without joining it to workflow completion.
          void Promise.resolve(result).catch((error: unknown) => {
            onError(error, redacted)
          })
        }
      },
      "trace",
      [envelope],
    )
  }

  /**
   * Removes every listener owned by this registry.
   */
  close(): void {
    this.#contentTraceListeners.clear()
    this.#hooks.removeAllHooks()
  }

  /**
   * Routes public listeners into Hookable's internal payload contracts.
   */
  #register<Name extends AmlEventName>(
    name: Name,
    listener: AmlEventListener<Name>,
    once: boolean,
  ): () => void {
    if (name === "trace") {
      return this.#registerTrace(listener as TraceSink, once)
    }

    return once
      ? this.#hooks.hookOnce(name, listener as never)
      : this.#hooks.hook(name, listener as never)
  }

  /**
   * Captures one trace listener's content policy for its full registration.
   */
  #registerTrace(listener: TraceSink, once: boolean): () => void {
    const captureContent = captureTraceContent(listener)
    const contentRegistration = captureContent
      ? Symbol("trace-content-listener")
      : undefined
    const releaseContent = () =>
      contentRegistration === undefined
        ? undefined
        : this.#contentTraceListeners.delete(contentRegistration)
    const invoke = (events: AmlTraceEnvelope) => {
      if (once) {
        releaseContent()
      }

      // Public observers may return any ignored value. Normalize it into one
      // completion Promise so rejected thenables still reach trace reporting.
      return Promise.resolve(
        Reflect.apply(listener, undefined, [
          captureContent ? events.content : events.redacted,
        ]),
      ).then(() => undefined)
    }
    const removeHook = once
      ? this.#hooks.hookOnce("trace", invoke)
      : this.#hooks.hook("trace", invoke)

    if (contentRegistration !== undefined) {
      this.#contentTraceListeners.add(contentRegistration)
    }

    return () => {
      releaseContent()
      removeHook()
    }
  }
}

/**
 * Reads one optional listener policy once at the registration boundary.
 */
function captureTraceContent(listener: TraceSink): boolean {
  let value: unknown

  try {
    value = Reflect.get(listener, "captureContent")
  } catch (cause) {
    throw new TypeError(
      "trace listener captureContent could not be read",
      { cause },
    )
  }

  if (value !== undefined && typeof value !== "boolean") {
    throw new TypeError(
      "trace listener captureContent must be a boolean",
    )
  }

  return value ?? false
}
