import type { WorkspaceAcquireRequest, WorkspaceProvider } from "../components/workspace/workspace-provider.js"
import {
  captureWorkspaceLease,
  captureWorkspaceRelease,
  validateWorkspaceLease,
  validateWorkspaceProvider,
} from "../components/workspace/validate-workspace-provider.js"
import { WorkspaceConflictError } from "../components/workspace/workspace-conflict-error.js"

/**
 * Exercises exclusive acquisition, persistence, release, and restoration.
 *
 * The check acquires the fixed logical id `"conformance-workspace"`, requires a
 * competing writer to fail with {@link WorkspaceConflictError}, saves and
 * releases the first lease, then reacquires, saves, and releases it again. It
 * preserves cleanup failures rather than abandoning acquired resources. A real
 * provider may create durable or billable state; run against an isolated test
 * namespace that may safely retain this id.
 *
 * @param provider Provider instance to validate and exercise.
 */
export async function workspaceProviderConformance(provider: WorkspaceProvider): Promise<void> {
  const validated = validateWorkspaceProvider(provider)
  const first = await acquireConformanceLease(validated, createRequest("first"))
  const conflictRequest = createRequest("competing")
  const competing = await Reflect.apply(validated.acquire, validated.provider, [conflictRequest]).then(
    value => ({ kind: "fulfilled" as const, value }),
    (error: unknown) => ({ error, kind: "rejected" as const })
  )

  if (competing.kind === "fulfilled") {
    return await rejectCompetingLease(validated.name, first, competing.value, conflictRequest)
  }

  if (!WorkspaceConflictError.is(competing.error, conflictRequest.id)) {
    return await releaseAfterFailure(competing.error, first.release, validated.name)
  }

  await saveAndRelease(first)

  const restored = await acquireConformanceLease(validated, createRequest("restored"))
  await saveAndRelease(restored)
}

function createRequest(phase: string): Readonly<WorkspaceAcquireRequest> {
  return Object.freeze({
    evaluationId: `workspace-provider-conformance-${phase}`,
    id: "conformance-workspace",
    signal: new AbortController().signal,
  })
}

/**
 * Validates a raw provider result while retaining the earliest cleanup method.
 */
async function acquireConformanceLease(
  provider: ReturnType<typeof validateWorkspaceProvider>,
  request: Readonly<WorkspaceAcquireRequest>
) {
  const value = await Reflect.apply(provider.acquire, provider.provider, [request])
  const releaseCapture = captureWorkspaceRelease(value, provider.name)
  let capture: ReturnType<typeof captureWorkspaceLease>

  try {
    capture = captureWorkspaceLease(releaseCapture, provider.name)
  } catch (error) {
    return await releaseAfterFailure(error, releaseCapture.release, provider.name)
  }

  try {
    return validateWorkspaceLease(capture, provider.name, request.id)
  } catch (error) {
    return await releaseAfterFailure(error, capture.release, provider.name)
  }
}

/**
 * Always releases a valid lease, preserving independent save failures.
 */
async function saveAndRelease(lease: ReturnType<typeof validateWorkspaceLease>): Promise<void> {
  let failed = false
  let failure: unknown

  try {
    await lease.save()
  } catch (error) {
    failed = true
    failure = error
  }

  try {
    await lease.release()
  } catch (releaseError) {
    if (failed) {
      throw new AggregateError([failure, releaseError], "Workspace provider failed persistence and cleanup")
    }

    throw releaseError
  }

  if (failed) {
    throw failure
  }
}

async function rejectCompetingLease(
  providerName: string,
  first: ReturnType<typeof validateWorkspaceLease>,
  value: unknown,
  request: Readonly<WorkspaceAcquireRequest>
): Promise<never> {
  let releaseSecond: (() => Promise<void>) | undefined
  let failure: unknown

  try {
    const release = captureWorkspaceRelease(value, providerName)
    releaseSecond = release.release
    const capture = captureWorkspaceLease(release, providerName)
    validateWorkspaceLease(capture, providerName, request.id)
    failure = new Error(`Workspace provider "${providerName}" allowed concurrent writers for "${request.id}"`)
  } catch (error) {
    failure = error
  }

  const cleanupErrors: unknown[] = []

  if (releaseSecond !== undefined) {
    try {
      await releaseSecond()
    } catch (error) {
      cleanupErrors.push(error)
    }
  }

  try {
    await first.release()
  } catch (error) {
    cleanupErrors.push(error)
  }

  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      [failure, ...cleanupErrors],
      `Workspace provider "${providerName}" allowed concurrent writers and cleanup failed`
    )
  }

  throw failure
}

async function releaseAfterFailure(
  failure: unknown,
  release: () => Promise<void>,
  providerName: string
): Promise<never> {
  try {
    await release()
  } catch (releaseError) {
    throw new AggregateError(
      [failure, releaseError],
      `Workspace provider "${providerName}" failed conformance and cleanup`
    )
  }

  throw failure
}
