import type { AgentExecutionContext } from "./agent-execution-context.js"
import type { AgentProviderSession, AgentProviderTurn } from "./agent-provider-session.js"
import type { AgentResponse } from "./agent-response.js"

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
  const requestAbort = () => {
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
      response = await Reflect.apply(runTurn as AgentProviderSession["runTurn"], value, [turn, context])
      context.signal.throwIfAborted()
    }
  } catch (error) {
    executionFailed = true
    // Cancellation is caller-owned control flow. Provider-native abort errors
    // must not replace the reason supplied at the AML boundary.
    executionError = context.signal.aborted ? context.signal.reason : error
  } finally {
    context.signal.removeEventListener("abort", requestAbort)
  }

  await abortPromise

  let cleanupError: unknown
  let cleanupFailed = false

  try {
    await closeSession()
  } catch (error) {
    cleanupFailed = true
    cleanupError = error
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
