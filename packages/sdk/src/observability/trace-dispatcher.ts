import { ComponentEvaluationContext } from "../core/component-evaluation-context.js"
import type { AmlTraceIdentity } from "../core/trace-identity.js"
import type {
  AmlTraceAttribute,
  AmlTraceEvent,
  AmlTraceEventName,
  AmlTraceSpanKind,
} from "./trace-event.js"
import type {
  TraceErrorHandler,
  TraceSink,
} from "./trace-sink.js"

type TraceAttributes = Readonly<
  Record<string, AmlTraceAttribute>
>

/**
 * Runtime-owned token that closes exactly one emitted span.
 */
export interface TraceSpan {
  readonly identity: AmlTraceIdentity
  readonly kind: AmlTraceSpanKind
  readonly name: string
  readonly startedAt: number
}

/**
 * Delivers one evaluation's immutable events without affecting its semantics.
 */
export class TraceDispatcher {
  readonly #captureContent: boolean
  readonly #onError: TraceErrorHandler | undefined
  readonly #sink: TraceSink | undefined
  readonly #activeSpans = new Set<string>()
  #closed = false
  #sequence = 0
  #warned = false

  /**
   * Captures the consumer boundary once for one isolated evaluation.
   */
  constructor(
    sink: TraceSink | undefined,
    captureContent: boolean,
    onError: TraceErrorHandler | undefined,
  ) {
    this.#sink = sink
    this.#captureContent = captureContent
    this.#onError = onError
  }

  /**
   * Emits a span start and returns the immutable token required to close it.
   */
  startSpan(
    identity: AmlTraceIdentity,
    kind: AmlTraceSpanKind,
    name: string,
    attributes: TraceAttributes = {},
    sensitiveAttributes: TraceAttributes = {},
  ): TraceSpan {
    const startedAt = performance.now()
    this.#activeSpans.add(identity.spanId)

    this.#emit({
      ...identity,
      attributes: this.#attributes(
        attributes,
        sensitiveAttributes,
      ),
      kind,
      name,
      sequence: this.#nextSequence(),
      timestamp: Date.now(),
      type: "span.start",
    })

    return Object.freeze({
      identity,
      kind,
      name,
      startedAt,
    })
  }

  /**
   * Emits the terminal event for a previously started span.
   */
  endSpan(
    span: TraceSpan,
    status: "error" | "ok",
    attributes: TraceAttributes = {},
    sensitiveAttributes: TraceAttributes = {},
  ): void {
    if (!this.#activeSpans.delete(span.identity.spanId)) {
      return
    }

    this.#emit({
      ...span.identity,
      attributes: this.#attributes(
        attributes,
        sensitiveAttributes,
      ),
      durationMs: Math.max(0, performance.now() - span.startedAt),
      kind: span.kind,
      name: span.name,
      sequence: this.#nextSequence(),
      status,
      timestamp: Date.now(),
      type: "span.end",
    })
  }

  /**
   * Closes a failed span without coercing an arbitrary thrown object.
   */
  failSpan(span: TraceSpan, error: unknown): void {
    const snapshot = captureError(error)

    this.endSpan(
      span,
      "error",
      { "error.type": snapshot.type },
      { "error.message": snapshot.message },
    )
  }

  /**
   * Emits one ordered fact that belongs to an existing span.
   */
  event(
    identity: AmlTraceIdentity,
    name: AmlTraceEventName,
    attributes: TraceAttributes = {},
    sensitiveAttributes: TraceAttributes = {},
  ): void {
    if (this.#closed) {
      return
    }

    this.#emit({
      ...identity,
      attributes: this.#attributes(
        attributes,
        sensitiveAttributes,
      ),
      name,
      sequence: this.#nextSequence(),
      timestamp: Date.now(),
      type: "event",
    })
  }

  /**
   * Drops any incorrectly detached events after evaluation completion.
   */
  close(): void {
    this.#closed = true
    this.#activeSpans.clear()
  }

  /**
   * Builds a frozen attribute snapshot, adding content only by explicit opt-in.
   */
  #attributes(
    attributes: TraceAttributes,
    sensitiveAttributes: TraceAttributes,
  ): TraceAttributes {
    const result: Record<string, AmlTraceAttribute> =
      Object.create(null) as Record<string, AmlTraceAttribute>

    for (const source of this.#captureContent
      ? [attributes, sensitiveAttributes]
      : [attributes]) {
      for (const [key, value] of Object.entries(source)) {
        result[key] = Array.isArray(value)
          ? Object.freeze([...value])
          : value
      }
    }

    return Object.freeze(result)
  }

  /**
   * Invokes a consumer outside component-local evaluate() authority.
   */
  #emit(event: AmlTraceEvent): void {
    if (this.#closed || this.#sink === undefined) {
      return
    }

    const immutableEvent = Object.freeze(event)
    let result: unknown

    try {
      result = ComponentEvaluationContext.withoutAccess(() =>
        Reflect.apply(this.#sink as TraceSink, undefined, [
          immutableEvent,
        ]),
      )
    } catch (error) {
      this.#report(error, immutableEvent)
      return
    }

    if (result === undefined) {
      return
    }

    // A trace callback is deliberately synchronous. Consume a returned
    // thenable so its later rejection is reported rather than becoming an
    // unhandled rejection, but never await it or delay the workflow.
    let then: unknown

    try {
      then = ComponentEvaluationContext.withoutAccess(() =>
        (typeof result === "object" && result !== null) ||
        typeof result === "function"
          ? Reflect.get(result, "then")
          : undefined,
      )
    } catch (error) {
      this.#report(error, immutableEvent)
      return
    }

    if (typeof then === "function") {
      const contractError = new TypeError(
        "AML trace sinks must not return a thenable",
      )
      this.#report(contractError, immutableEvent)

      void new Promise<unknown>((resolve, reject) => {
        queueMicrotask(() => {
          ComponentEvaluationContext.withoutAccess(() => {
            try {
              Reflect.apply(then, result, [resolve, reject])
            } catch (error) {
              reject(error)
            }
          })
        })
      }).catch((error: unknown) => {
        this.#report(error, immutableEvent)
      })
    }
  }

  /**
   * Reports observer failures without re-entering workflow control flow.
   */
  #report(error: unknown, event: AmlTraceEvent): void {
    if (this.#onError !== undefined) {
      try {
        const result = ComponentEvaluationContext.withoutAccess(() =>
          Reflect.apply(this.#onError as TraceErrorHandler, undefined, [
            error,
            event,
          ]),
        ) as unknown

        // Secondary handlers are also out-of-band. Swallow any asynchronous
        // rejection without recursively reporting observer failures.
        if (
          (typeof result === "object" && result !== null) ||
          typeof result === "function"
        ) {
          let then: unknown

          try {
            then = ComponentEvaluationContext.withoutAccess(() =>
              Reflect.get(result, "then"),
            )
          } catch {
            return
          }

          if (typeof then === "function") {
            void new Promise<unknown>((resolve, reject) => {
              queueMicrotask(() => {
                ComponentEvaluationContext.withoutAccess(() => {
                  try {
                    Reflect.apply(then, result, [resolve, reject])
                  } catch (handlerError) {
                    reject(handlerError)
                  }
                })
              })
            }).catch(() => undefined)
          }
        }
      } catch {
        // The secondary channel must never become another workflow boundary.
      }

      return
    }

    if (this.#warned) {
      return
    }

    this.#warned = true

    try {
      console.error(
        `[aml] trace sink failed at ${event.type} ${event.spanId}`,
      )
    } catch {
      // Even a replaced console cannot make tracing part of workflow behavior.
    }
  }

  /**
   * Allocates one monotonically increasing event number.
   */
  #nextSequence(): number {
    this.#sequence += 1
    return this.#sequence
  }
}

/**
 * Reads only primitive or genuine Error fields and survives hostile proxies.
 */
function captureError(
  error: unknown,
): Readonly<{ message: string; type: string }> {
  if (error === null) {
    return { message: "null", type: "null" }
  }

  const primitiveType = typeof error

  if (
    primitiveType !== "object" &&
    primitiveType !== "function"
  ) {
    return {
      message:
        primitiveType === "string"
          ? (error as string)
          : primitiveType,
      type: primitiveType,
    }
  }

  try {
    if (error instanceof Error) {
      let message = "Error"
      let type = "Error"

      try {
        const value = Reflect.get(error, "name")

        if (typeof value === "string" && value.length > 0) {
          type = value
        }
      } catch {
        // A proxy around Error may reject field access; use safe defaults.
      }

      try {
        const value = Reflect.get(error, "message")

        if (typeof value === "string") {
          message = value
        }
      } catch {
        // Error text is optional sensitive telemetry, never workflow data.
      }

      return { message, type }
    }
  } catch {
    // A hostile proxy can throw from instanceof's prototype traversal.
  }

  return {
    message: "Non-Error object was thrown",
    type: primitiveType,
  }
}
