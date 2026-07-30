import { randomUUID } from "node:crypto"

import { EvaluationError } from "../../core/evaluation-error.js"
import { resolvePortablePath } from "../../core/resolve-portable-path.js"
import type { WorkspaceLoadOptions, WorkspaceProps, WorkspaceSaveOptions } from "./workspace.js"
import type {
  WorkspaceLoadRequest,
  WorkspaceMaterializationReference,
  WorkspaceProvider,
  WorkspaceSaveRequest,
} from "./workspace-provider.js"
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
   * Applies outcome policy and releases the provider lease exactly once.
   */
  complete(outcome: "failure" | "success"): Promise<void>
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
    const workspaceId = validateWorkspaceId(props.id ?? randomUUID())
    const cwd = resolvePortablePath(".", props.cwd ?? ".", "<Workspace> cwd")
    const load = normalizeWorkspaceLoad(props.load ?? true)
    const lock = normalizeWorkspaceLock(props.lock ?? true)
    const save = normalizeWorkspaceSave(props.save ?? false)
    const writeConcurrency = normalizeWriteConcurrency(props.writeConcurrency ?? "serial")
    const provider = props.provider === undefined ? this.#provider : validateWorkspaceProvider(props.provider)

    if (provider === undefined) {
      throw new EvaluationError("<Workspace> requires a provider or AmlRuntime workspaceProvider")
    }

    const request = Object.freeze({
      evaluationId,
      id: workspaceId,
      load,
      lock,
      save: save !== false,
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
      lease = validateWorkspaceLease(capture, provider.name, workspaceId, cwd, writeConcurrency)
    } catch (leaseError) {
      // No descendant has run, so an invalid materialization is released
      // without persisting provider data AML could not safely inspect.
      return await throwAfterInvalidLease(leaseError, capture.release, provider.name, signal)
    }

    return createWorkspaceScope(lease, save, signal)
  }
}

function normalizeWorkspaceLock(value: unknown): boolean {
  if (typeof value !== "boolean") {
    throw new EvaluationError("<Workspace> lock must be a boolean")
  }

  return value
}

function normalizeWriteConcurrency(value: unknown): "parallel" | "serial" {
  if (value !== "parallel" && value !== "serial") {
    throw new EvaluationError('<Workspace> writeConcurrency must be "parallel" or "serial"')
  }

  return value
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
function createWorkspaceScope(
  lease: Readonly<ValidatedWorkspaceLease>,
  save: false | NormalizedWorkspaceSave,
  signal: AbortSignal
): Readonly<WorkspaceEvaluationScope> {
  let completion: Promise<void> | undefined

  return Object.freeze({
    complete(outcome: "failure" | "success") {
      completion ??= saveAndReleaseWorkspace(lease, save, outcome, signal)
      return completion
    },
    materialization: lease.materialization,
  })
}

/**
 * Persists before release and preserves both independent provider failures.
 */
async function saveAndReleaseWorkspace(
  lease: Readonly<ValidatedWorkspaceLease>,
  save: false | NormalizedWorkspaceSave,
  outcome: "failure" | "success",
  signal: AbortSignal
): Promise<void> {
  const errors: unknown[] = []
  const shouldSave = save !== false && !signal.aborted && (save.on === "always" || outcome === "success")

  if (shouldSave) {
    try {
      const request: WorkspaceSaveRequest = Object.freeze({
        exclude: save.exclude,
        gitignore: save.gitignore,
        ...(save.include === undefined ? {} : { include: save.include }),
        outcome,
        retention: save.retention,
        signal,
      })
      await lease.save(request)
    } catch (error) {
      errors.push(error)
    }
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

interface NormalizedWorkspaceSave {
  readonly exclude: readonly string[]
  readonly gitignore: boolean
  readonly include?: readonly string[]
  readonly on: "always" | "success"
  readonly retention: number
}

/**
 * Converts authoring shorthands into one provider-facing load request.
 */
function normalizeWorkspaceLoad(value: boolean | WorkspaceLoadOptions): false | Readonly<WorkspaceLoadRequest> {
  if (value === false) {
    return false
  }

  if (value === true) {
    return Object.freeze({
      exclude: Object.freeze([]),
      revision: "current" as const,
    })
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new EvaluationError("<Workspace> load must be a boolean or options object")
  }

  const revision = value.revision ?? "current"

  if (typeof revision !== "string" || revision.length === 0 || revision !== revision.trim()) {
    throw new EvaluationError("<Workspace> load revision must be a non-empty normalized string")
  }

  const include = normalizeWorkspacePatterns(value.include, "load include")
  return Object.freeze({
    exclude: normalizeWorkspacePatterns(value.exclude, "load exclude") ?? Object.freeze([]),
    ...(include === undefined ? {} : { include }),
    revision,
  })
}

/**
 * Captures save defaults once before provider acquisition.
 */
function normalizeWorkspaceSave(value: boolean | WorkspaceSaveOptions): false | Readonly<NormalizedWorkspaceSave> {
  if (value === false) {
    return false
  }

  if (value !== true && (typeof value !== "object" || value === null || Array.isArray(value))) {
    throw new EvaluationError("<Workspace> save must be a boolean or options object")
  }

  const options = value === true ? {} : value
  const on = options.on ?? "success"

  if (on !== "always" && on !== "success") {
    throw new EvaluationError('<Workspace> save on must be "always" or "success"')
  }

  const retention = options.retention ?? 1

  if (!Number.isSafeInteger(retention) || retention <= 0) {
    throw new EvaluationError("<Workspace> save retention must be a positive safe integer")
  }

  const gitignore = options.gitignore ?? true

  if (typeof gitignore !== "boolean") {
    throw new EvaluationError("<Workspace> save gitignore must be a boolean")
  }

  const include = normalizeWorkspacePatterns(options.include, "save include")
  return Object.freeze({
    exclude: normalizeWorkspacePatterns(options.exclude, "save exclude") ?? Object.freeze([]),
    gitignore,
    ...(include === undefined ? {} : { include }),
    on,
    retention,
  })
}

/**
 * Rejects ambiguous negation and host-style paths at the authored boundary.
 */
function normalizeWorkspacePatterns(
  value: readonly string[] | undefined,
  label: string
): readonly string[] | undefined {
  if (value === undefined) {
    return undefined
  }

  if (!Array.isArray(value)) {
    throw new EvaluationError(`<Workspace> ${label} must be an array`)
  }

  return Object.freeze(
    value.map((pattern, index) => {
      if (
        typeof pattern !== "string" ||
        pattern.length === 0 ||
        pattern !== pattern.trim() ||
        pattern.startsWith("!") ||
        pattern.startsWith("/") ||
        pattern.includes("\\") ||
        pattern.split("/").includes("..")
      ) {
        throw new EvaluationError(
          `<Workspace> ${label}[${index}] must be a normalized relative forward-slash glob without negation`
        )
      }

      return pattern
    })
  )
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
