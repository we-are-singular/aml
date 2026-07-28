import { EvaluationError } from "../../core/evaluation-error.js"
import type { WorkspaceProps } from "./workspace.js"
import type { WorkspaceMaterializationReference, WorkspaceProvider } from "./workspace-provider.js"
import {
  captureWorkspaceLease,
  captureWorkspaceRelease,
  type ValidatedWorkspaceLease,
  type ValidatedWorkspaceProvider,
  validateWorkspaceLease,
  validateWorkspaceProvider,
} from "./validate-workspace-provider.js"

/**
 * Runtime-owned Workspace materialization and exactly-once completion.
 */
export interface WorkspaceEvaluationScope {
  readonly materialization: Readonly<WorkspaceMaterializationReference>

  /**
   * Saves current files and releases the provider lease exactly once.
   */
  complete(): Promise<void>
}

/**
 * Owns Workspace validation, acquisition, persistence, and release ordering.
 */
export class WorkspaceEvaluator {
  readonly #provider: Readonly<ValidatedWorkspaceProvider> | undefined

  /**
   * Captures an optional runtime-wide provider without acquiring resources.
   */
  constructor(provider?: WorkspaceProvider) {
    this.#provider = provider === undefined ? undefined : validateWorkspaceProvider(provider)
  }

  /**
   * Acquires one exclusive materialization for an authored Workspace.
   */
  async enter(
    props: Readonly<WorkspaceProps>,
    evaluationId: string,
    signal: AbortSignal
  ): Promise<Readonly<WorkspaceEvaluationScope>> {
    const workspaceId = validateWorkspaceId(props.id)
    const provider = props.provider === undefined ? this.#provider : validateWorkspaceProvider(props.provider)

    if (provider === undefined) {
      throw new EvaluationError("<Workspace> requires a provider or AmlRuntime workspaceProvider")
    }

    const request = Object.freeze({
      evaluationId,
      id: workspaceId,
      signal,
    })
    let value: unknown

    try {
      value = await Reflect.apply(provider.acquire, provider.provider, [request])
    } catch (cause) {
      signal.throwIfAborted()
      throw new EvaluationError(`Workspace provider "${provider.name}" failed to acquire`, { cause })
    }

    let releaseCapture: ReturnType<typeof captureWorkspaceRelease>

    try {
      releaseCapture = captureWorkspaceRelease(value, provider.name)
    } catch (leaseError) {
      if (signal.aborted) {
        throw new AggregateError(
          [signal.reason, leaseError],
          `Workspace provider "${provider.name}" completed cancelled acquisition with an invalid lease`
        )
      }

      throw leaseError
    }

    if (signal.aborted) {
      try {
        await releaseCapture.release()
      } catch (releaseError) {
        throw new AggregateError(
          [signal.reason, releaseError],
          "Workspace acquisition was cancelled and cleanup failed"
        )
      }

      throw signal.reason
    }

    let capture: ReturnType<typeof captureWorkspaceLease>

    try {
      capture = captureWorkspaceLease(releaseCapture, provider.name)
    } catch (leaseError) {
      return await throwAfterInvalidLease(leaseError, releaseCapture.release, provider.name, signal)
    }

    let lease: Readonly<ValidatedWorkspaceLease>

    try {
      lease = validateWorkspaceLease(capture, provider.name, workspaceId)
    } catch (leaseError) {
      // No descendant has run, so an invalid materialization is released
      // without persisting provider data AML could not safely inspect.
      return await throwAfterInvalidLease(leaseError, capture.release, provider.name, signal)
    }

    return createWorkspaceScope(lease)
  }
}

/**
 * Releases a malformed lease while retaining a concurrent cancellation reason.
 */
async function throwAfterInvalidLease(
  leaseError: unknown,
  release: () => Promise<void>,
  providerName: string,
  signal: AbortSignal
): Promise<never> {
  const cancellationCaptured = signal.aborted
  const errors: unknown[] = cancellationCaptured ? [signal.reason, leaseError] : [leaseError]

  try {
    await release()
  } catch (releaseError) {
    errors.push(releaseError)
  }

  // Cleanup may suspend long enough for a new cancellation to arrive.
  if (!cancellationCaptured && signal.aborted) {
    errors.unshift(signal.reason)
  }

  if (errors.length === 1) {
    throw errors[0]
  }

  throw new AggregateError(
    errors,
    `Workspace provider "${providerName}" returned an invalid lease and cleanup failed or raced cancellation`
  )
}

/**
 * Creates an idempotent completion barrier around save-then-release.
 */
function createWorkspaceScope(lease: Readonly<ValidatedWorkspaceLease>): Readonly<WorkspaceEvaluationScope> {
  let completion: Promise<void> | undefined

  return Object.freeze({
    complete() {
      completion ??= saveAndReleaseWorkspace(lease)
      return completion
    },
    materialization: lease.materialization,
  })
}

/**
 * Persists before release and preserves both independent provider failures.
 */
async function saveAndReleaseWorkspace(lease: Readonly<ValidatedWorkspaceLease>): Promise<void> {
  const errors: unknown[] = []

  try {
    await lease.save()
  } catch (error) {
    errors.push(error)
  }

  try {
    await lease.release()
  } catch (error) {
    errors.push(error)
  }

  if (errors.length === 1) {
    throw errors[0]
  }

  if (errors.length > 1) {
    throw new AggregateError(errors, "Workspace save and release both failed")
  }
}

/**
 * Rejects identities that change through implicit trimming or empty values.
 */
function validateWorkspaceId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new EvaluationError("<Workspace> id must be a non-empty normalized string")
  }

  return value
}
