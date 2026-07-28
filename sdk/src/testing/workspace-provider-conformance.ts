import type { WorkspaceAcquireRequest, WorkspaceProvider } from "../components/workspace/workspace-provider.js"
import {
  captureWorkspaceLease,
  captureWorkspaceRelease,
  validateWorkspaceLease,
  validateWorkspaceProvider,
  type ValidatedWorkspaceLease,
  type ValidatedWorkspaceProvider,
} from "../components/workspace/validate-workspace-provider.js"
import { WorkspaceConflictError } from "../components/workspace/workspace-conflict-error.js"

const DEFAULT_CONFLICT_TIMEOUT_MS = 5_000

type ProviderAcquisitionOutcome =
  | Readonly<{ kind: "fulfilled"; value: unknown }>
  | Readonly<{ error: unknown; kind: "rejected" }>

type TimedAcquisitionOutcome = ProviderAcquisitionOutcome | Readonly<{ kind: "timeout" }>

/**
 * Timing used only to report a provider that waits instead of rejecting.
 */
export interface WorkspaceProviderConformanceOptions {
  readonly conflictTimeoutMs?: number
}

/**
 * Exercises lifecycle and exclusive-writer behavior for one Workspace id.
 *
 * The first lease remains active until the competing acquisition settles.
 * This deliberately requires conflict rejection instead of guessing whether
 * an unresolved Promise represents locking or ordinary provider latency.
 */
export async function workspaceProviderConformance(
  provider: WorkspaceProvider,
  options: WorkspaceProviderConformanceOptions = {}
): Promise<void> {
  const validatedProvider = validateWorkspaceProvider(provider)
  const conflictTimeoutMs = validateConflictTimeout(options.conflictTimeoutMs ?? DEFAULT_CONFLICT_TIMEOUT_MS)
  const first = await acquireConformanceLease(validatedProvider, createConformanceRequest("first"))
  const conflictController = new AbortController()
  const conflictRequest = createConformanceRequest("competing", conflictController.signal)
  const competing = observeProviderAcquisition(acquireProviderValue(validatedProvider, conflictRequest))
  const outcome = await waitForAcquisition(competing, conflictTimeoutMs)

  if (outcome.kind === "timeout") {
    return await failTimedOutConflictProbe(
      validatedProvider.name,
      first,
      competing,
      conflictController,
      conflictTimeoutMs
    )
  }

  if (outcome.kind === "fulfilled") {
    const contractError = new Error(
      `Workspace provider "${validatedProvider.name}" allowed concurrent writers for "conformance-workspace"`
    )
    const cleanupErrors = await releaseConformanceResources(first, outcome.value, validatedProvider.name)
    throwWithCleanup(
      contractError,
      cleanupErrors,
      `Workspace provider "${validatedProvider.name}" violated exclusive-writer conformance and cleanup failed`
    )
  }

  if (!WorkspaceConflictError.is(outcome.error, conflictRequest.id)) {
    const cleanupErrors = await releaseValidatedLeases([first])
    throwWithCleanup(
      outcome.error,
      cleanupErrors,
      `Workspace provider "${validatedProvider.name}" failed conflict probing and cleanup`
    )
  }

  await saveAndRelease(first, validatedProvider.name)
  // Conflict rejection is conformant only if release restores availability.
  const reacquired = await acquireConformanceLease(validatedProvider, createConformanceRequest("reacquired"))
  await saveAndRelease(reacquired, validatedProvider.name)
}

/**
 * Builds one immutable request while retaining the same durable identity.
 */
function createConformanceRequest(
  phase: string,
  signal = new AbortController().signal
): Readonly<WorkspaceAcquireRequest> {
  return Object.freeze({
    evaluationId: `workspace-provider-conformance-${phase}`,
    id: "conformance-workspace",
    signal,
  })
}

/**
 * Invokes only the provider acquisition boundary without classifying its value.
 */
async function acquireProviderValue(
  validatedProvider: Readonly<ValidatedWorkspaceProvider>,
  request: Readonly<WorkspaceAcquireRequest>
): Promise<unknown> {
  return await Reflect.apply(validatedProvider.acquire, validatedProvider.provider, [request])
}

/**
 * Converts raw provider settlement into a Promise that never rejects.
 */
function observeProviderAcquisition(acquisition: Promise<unknown>): Promise<ProviderAcquisitionOutcome> {
  return acquisition.then(
    value => Object.freeze({ kind: "fulfilled", value }),
    (error: unknown) => Object.freeze({ error, kind: "rejected" })
  )
}

/**
 * Acquires and validates one lease without leaking malformed provider output.
 */
async function acquireConformanceLease(
  validatedProvider: Readonly<ValidatedWorkspaceProvider>,
  request: Readonly<WorkspaceAcquireRequest>
): Promise<Readonly<ValidatedWorkspaceLease>> {
  const value = await acquireProviderValue(validatedProvider, request)
  return await captureConformanceLease(value, validatedProvider, request)
}

/**
 * Validates one fulfilled acquisition while retaining cleanup on bad leases.
 */
async function captureConformanceLease(
  value: unknown,
  validatedProvider: Readonly<ValidatedWorkspaceProvider>,
  request: Readonly<WorkspaceAcquireRequest>
): Promise<Readonly<ValidatedWorkspaceLease>> {
  const releaseCapture = captureWorkspaceRelease(value, validatedProvider.name)
  let capture: ReturnType<typeof captureWorkspaceLease>

  try {
    capture = captureWorkspaceLease(releaseCapture, validatedProvider.name)
  } catch (error) {
    try {
      await releaseCapture.release()
    } catch (releaseError) {
      throw new AggregateError(
        [error, releaseError],
        `Workspace provider "${validatedProvider.name}" failed conformance and cleanup`
      )
    }

    throw error
  }

  try {
    return validateWorkspaceLease(capture, validatedProvider.name, request.id)
  } catch (error) {
    try {
      await capture.release()
    } catch (releaseError) {
      throw new AggregateError(
        [error, releaseError],
        `Workspace provider "${validatedProvider.name}" failed conformance and cleanup`
      )
    }

    throw error
  }
}

/**
 * Persists a conformant lease and always relinquishes its writer authority.
 */
async function saveAndRelease(lease: Readonly<ValidatedWorkspaceLease>, providerName: string): Promise<void> {
  const errors: unknown[] = []

  try {
    await lease.save()
  } catch (error) {
    errors.push(error)
  }

  try {
    await lease.release()
  } catch (releaseError) {
    errors.push(releaseError)
  }

  if (errors.length === 1) {
    throw errors[0]
  }

  if (errors.length > 1) {
    throw new AggregateError(errors, `Workspace provider "${providerName}" failed conformance persistence and cleanup`)
  }
}

/**
 * Bounds a conflict probe without abandoning a serialized late lease.
 */
async function failTimedOutConflictProbe(
  providerName: string,
  first: Readonly<ValidatedWorkspaceLease>,
  competing: Promise<ProviderAcquisitionOutcome>,
  controller: AbortController,
  timeoutMs: number
): Promise<never> {
  const timeoutError = new Error(
    `Workspace provider "${providerName}" did not reject a competing writer within ${timeoutMs}ms`
  )
  controller.abort(timeoutError)
  const cleanupErrors = await releaseValidatedLeases([first])

  // Releasing the first lease can wake an invalid serializing provider. Give
  // that late result one bounded cancellation window, then release it too.
  const lateOutcome = await waitForAcquisition(competing, timeoutMs)

  if (lateOutcome.kind === "fulfilled") {
    const releaseErrors = await releaseProviderValue(lateOutcome.value, providerName)
    cleanupErrors.push(...releaseErrors)
  } else if (lateOutcome.kind === "timeout") {
    // A provider that ignores both cancellation and release is already
    // non-conformant. Retain a best-effort cleanup owner for any later value.
    void competing.then(async event => {
      if (event.kind === "fulfilled") {
        await releaseProviderValue(event.value, providerName)
      }
    })
  }

  throwWithCleanup(
    timeoutError,
    cleanupErrors,
    `Workspace provider "${providerName}" timed out during conflict probing and cleanup failed`
  )
}

/**
 * Releases a known lease plus cleanup authority from a raw competing value.
 */
async function releaseConformanceResources(
  first: Readonly<ValidatedWorkspaceLease>,
  competingValue: unknown,
  providerName: string
): Promise<unknown[]> {
  const errors = await releaseProviderValue(competingValue, providerName)
  errors.push(...(await releaseValidatedLeases([first])))
  return errors
}

/**
 * Captures and invokes release from an otherwise invalid provider value.
 */
async function releaseProviderValue(value: unknown, providerName: string): Promise<unknown[]> {
  try {
    const capture = captureWorkspaceRelease(value, providerName)
    await capture.release()
    return []
  } catch (error) {
    return [error]
  }
}

/**
 * Releases each validated lease once and reports every cleanup failure.
 */
async function releaseValidatedLeases(leases: readonly Readonly<ValidatedWorkspaceLease>[]): Promise<unknown[]> {
  const errors: unknown[] = []

  for (const lease of leases) {
    try {
      await lease.release()
    } catch (error) {
      errors.push(error)
    }
  }

  return errors
}

/**
 * Preserves the primary failure alongside any independent cleanup failures.
 */
function throwWithCleanup(primaryError: unknown, cleanupErrors: readonly unknown[], message: string): never {
  if (cleanupErrors.length > 0) {
    throw new AggregateError([primaryError, ...cleanupErrors], message)
  }

  throw primaryError
}

/**
 * Resolves with provider settlement or one cleared deadline marker.
 */
function waitForAcquisition(
  acquisition: Promise<ProviderAcquisitionOutcome>,
  timeoutMs: number
): Promise<TimedAcquisitionOutcome> {
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      resolve(Object.freeze({ kind: "timeout" }))
    }, timeoutMs)

    void acquisition.then(outcome => {
      clearTimeout(timer)
      resolve(outcome)
    })
  })
}

/**
 * Rejects invalid or unbounded testing deadlines.
 */
function validateConflictTimeout(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new RangeError("Workspace provider conformance conflictTimeoutMs must be a positive safe integer")
  }

  return value as number
}
