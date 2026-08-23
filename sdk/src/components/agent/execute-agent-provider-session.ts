import type { AgentExecutionContext } from "./agent-execution-context.js"
import type { AgentProviderSession, AgentProviderTurn } from "./agent-provider-session.js"
import type { AgentResponse } from "./agent-response.js"
import { agentObservabilityServices } from "./agent-observability-services.js"
import { AgentTimeoutError } from "./agent-timeout.js"

/**
 * Executes a captured provider session and preserves lifecycle failures in
 * deterministic execution, abort, then cleanup order.
 */
export async function executeAgentProviderSession(
  value: AgentProviderSession,
  turns: readonly Readonly<AgentProviderTurn>[],
  context: AgentExecutionContext,
  providerName: string
): Promise<AgentResponse> {
  if (typeof value !== "object" || value === null) {
    throw new TypeError(`Agent provider "${providerName}" returned an invalid session`)
  }

  let close: unknown

  try {
    // Cleanup authority is captured before any other provider-owned accessor.
    close = value.close
  } catch (cause) {
    throw new TypeError(`Agent provider "${providerName}" returned a session with unreadable close()`, { cause })
  }

  if (typeof close !== "function") {
    throw new TypeError(`Agent provider "${providerName}" returned a session without close()`)
  }

  const closeSession = async () => {
    await Reflect.apply(close as AgentProviderSession["close"], value, [])
  }
  const observability = agentObservabilityServices(context)
  const sessionTrace = observability.currentTrace()

  let abort: unknown
  let runTurn: unknown

  try {
    abort = value.abort
    runTurn = value.runTurn
  } catch (cause) {
    return await rejectAfterClose(
      new TypeError(`Agent provider "${providerName}" returned an unreadable session`, { cause }),
      closeSession,
      providerName
    )
  }

  if (abort !== undefined && typeof abort !== "function") {
    return await rejectAfterClose(
      new TypeError(`Agent provider "${providerName}" session abort must be a function when provided`),
      closeSession,
      providerName
    )
  }

  if (typeof runTurn !== "function") {
    return await rejectAfterClose(
      new TypeError(`Agent provider "${providerName}" returned a session without runTurn()`),
      closeSession,
      providerName
    )
  }

  let abortError: unknown
  let abortFailed = false
  let abortPromise: Promise<void> | undefined
  let cancellationObserved = false

  const traceCancellation = () => {
    if (cancellationObserved) return

    cancellationObserved = true
    const reason = context.signal.reason
    observability.event(sessionTrace, "agent.session", {
      ...(AgentTimeoutError.is(reason) ? { reason: "timeout", timeoutMs: reason.timeoutMs } : {}),
      state: "cancellation_requested",
    })
  }

  // Cancellation notification is observable immediately, but the caller's
  // AbortSignal reason remains authoritative over any provider abort failure.
  const requestAbort = () => {
    traceCancellation()

    if (abort === undefined) {
      return
    }

    abortPromise ??= Promise.resolve()
      .then(async () => {
        await Reflect.apply(abort as NonNullable<AgentProviderSession["abort"]>, value, [])
      })
      .catch((error: unknown) => {
        abortFailed = true
        abortError = error
      })
  }

  if (context.signal.aborted) {
    requestAbort()
  } else {
    context.signal.addEventListener("abort", requestAbort, { once: true })
  }

  let executionError: unknown
  let executionFailed = false
  let response: AgentResponse | undefined

  try {
    for (const turn of turns) {
      context.signal.throwIfAborted()

      // Create the span immediately before runTurn(). This is deliberately not
      // derived from the authored plan earlier, because that produced traces
      // claiming later turns had started while the current turn was still busy.
      const turnTrace = observability.createTrace(sessionTrace.spanId)
      const turnSpan = observability.startSpan(
        turnTrace,
        "agent.turn",
        {
          index: turn.index + 1,
          kind: turn.index === 0 ? "initial" : "follow-up",
        },
        { prompt: turn.prompt }
      )

      // ACP updates and structured-output callbacks arrive asynchronously
      // during runTurn(), so route them to this exact turn until it settles.
      observability.setCurrentTrace(turnTrace)

      try {
        response = await Reflect.apply(runTurn as AgentProviderSession["runTurn"], value, [turn, context])
        context.signal.throwIfAborted()
        observability.endSpan(turnSpan, "ok")
      } catch (error) {
        observability.failSpan(turnSpan, error)
        throw error
      } finally {
        observability.setCurrentTrace(sessionTrace)
      }
    }
  } catch (error) {
    executionFailed = true
    // Cancellation is caller-owned control flow. Provider-native abort errors
    // must not replace the reason supplied at the AML boundary.
    executionError = context.signal.aborted ? context.signal.reason : error
  } finally {
    context.signal.removeEventListener("abort", requestAbort)
  }

  // Provider cancellation must settle before cleanup touches the same session.
  // Both failures are retained below in their actual lifecycle order.
  await abortPromise

  let cleanupError: unknown
  let cleanupFailed = false

  // Cleanup is its own child span because it can remain active after a failed
  // or cancelled turn and can independently fail.
  const cleanupTrace = observability.createTrace(sessionTrace.spanId)
  const cleanupSpan = observability.startSpan(cleanupTrace, "agent.cleanup")
  observability.setCurrentTrace(cleanupTrace)

  try {
    await closeSession()
    observability.endSpan(cleanupSpan, "ok")
  } catch (error) {
    observability.failSpan(cleanupSpan, error)
    cleanupFailed = true
    cleanupError = error
  } finally {
    observability.setCurrentTrace(sessionTrace)
  }

  // Cancellation can arrive after turn execution while close() is settling.
  // Cleanup already owns the session then, so preserve the reason without
  // racing abort() against the provider's close() implementation.
  if (context.signal.aborted && !executionFailed) {
    traceCancellation()
    executionFailed = true
    executionError = context.signal.reason
  }

  const errors: unknown[] = []

  if (executionFailed) {
    errors.push(executionError)
  }

  if (abortFailed) {
    errors.push(abortError)
  }

  if (cleanupFailed) {
    errors.push(cleanupError)
  }

  if (errors.length === 1) {
    throw errors[0]
  }

  if (errors.length > 1) {
    throw new AggregateError(errors, `Agent provider "${providerName}" session execution and cleanup failed`)
  }

  if (response === undefined) {
    throw new Error(`Agent provider "${providerName}" session produced no response`)
  }

  return response
}

async function rejectAfterClose(error: unknown, close: () => Promise<void>, providerName: string): Promise<never> {
  try {
    await close()
  } catch (cleanupError) {
    throw new AggregateError(
      [error, cleanupError],
      `Agent provider "${providerName}" session validation and cleanup failed`
    )
  }

  throw error
}
