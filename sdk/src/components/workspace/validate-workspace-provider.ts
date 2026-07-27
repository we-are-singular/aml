import type {
  WorkspaceMaterializationReference,
  WorkspaceProvider,
} from "./workspace-provider.js"

/**
 * Captured provider members used without rereading mutable public properties.
 */
export interface ValidatedWorkspaceProvider {
  readonly acquire: WorkspaceProvider["acquire"]
  readonly name: string
  readonly provider: WorkspaceProvider
}

/**
 * Lifecycle methods captured before untrusted lease identity fields.
 */
export interface WorkspaceLeaseCapture {
  readonly release: () => Promise<void>
  readonly save: () => Promise<void>
  readonly value: object
}

/**
 * Release authority captured before any other external lease member.
 */
export interface WorkspaceReleaseCapture {
  readonly release: () => Promise<void>
  readonly value: object
}

/**
 * Stable lease data and private lifecycle methods owned by the evaluator.
 */
export interface ValidatedWorkspaceLease {
  readonly materialization: Readonly<WorkspaceMaterializationReference>
  readonly release: () => Promise<void>
  readonly save: () => Promise<void>
}

/**
 * Validates a Workspace provider and captures one stable invocation surface.
 */
export function validateWorkspaceProvider(
  value: unknown,
): Readonly<ValidatedWorkspaceProvider> {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Workspace provider must be an object")
  }

  const candidate = value as {
    readonly acquire?: unknown
    readonly name?: unknown
  }
  const name = candidate.name
  const acquire = candidate.acquire

  if (typeof name !== "string" || name.length === 0) {
    throw new TypeError(
      "Workspace provider name must be a non-empty string",
    )
  }

  if (name !== name.trim()) {
    throw new TypeError(
      "Workspace provider name must already be normalized",
    )
  }

  if (typeof acquire !== "function") {
    throw new TypeError("Workspace provider acquire must be a function")
  }

  return Object.freeze({
    acquire: acquire as WorkspaceProvider["acquire"],
    name,
    provider: value as WorkspaceProvider,
  })
}

/**
 * Captures release before any other external lease member is inspected.
 */
export function captureWorkspaceRelease(
  value: unknown,
  providerName: string,
): Readonly<WorkspaceReleaseCapture> {
  if (typeof value !== "object" || value === null) {
    throw new TypeError(
      `Workspace provider "${providerName}" returned an invalid lease`,
    )
  }

  const candidate = value as {
    readonly release?: unknown
  }
  let release: unknown

  try {
    release = candidate.release
  } catch (cause) {
    throw new TypeError(
      `Workspace provider "${providerName}" returned a lease with an unreadable release method`,
      { cause },
    )
  }

  if (typeof release !== "function") {
    throw new TypeError(
      `Workspace provider "${providerName}" returned a lease without release()`,
    )
  }

  return Object.freeze({
    async release() {
      await Reflect.apply(release, value, [])
    },
    value,
  })
}

/**
 * Captures save after release is already available for malformed-lease cleanup.
 */
export function captureWorkspaceLease(
  releaseCapture: WorkspaceReleaseCapture,
  providerName: string,
): Readonly<WorkspaceLeaseCapture> {
  const candidate = releaseCapture.value as {
    readonly save?: unknown
  }
  let save: unknown

  try {
    save = candidate.save
  } catch (cause) {
    throw new TypeError(
      `Workspace provider "${providerName}" returned a lease with an unreadable save method`,
      { cause },
    )
  }

  if (typeof save !== "function") {
    throw new TypeError(
      `Workspace provider "${providerName}" returned a lease without save()`,
    )
  }

  return Object.freeze({
    release: releaseCapture.release,
    async save() {
      await Reflect.apply(save, releaseCapture.value, [])
    },
    value: releaseCapture.value,
  })
}

/**
 * Validates and snapshots a captured lease for one authored Workspace id.
 */
export function validateWorkspaceLease(
  capture: WorkspaceLeaseCapture,
  providerName: string,
  workspaceId: string,
): Readonly<ValidatedWorkspaceLease> {
  const candidate = capture.value as {
    readonly directory?: unknown
    readonly handle?: unknown
    readonly id?: unknown
  }
  let directory: unknown
  let handle: unknown
  let leaseId: unknown

  try {
    directory = candidate.directory
    handle = candidate.handle
    leaseId = candidate.id
  } catch (cause) {
    throw new TypeError(
      `Workspace provider "${providerName}" returned a lease with unreadable materialization data`,
      { cause },
    )
  }

  if (
    typeof directory !== "string" ||
    directory.length === 0 ||
    directory !== directory.trim()
  ) {
    throw new TypeError(
      `Workspace provider "${providerName}" returned a lease with an invalid directory`,
    )
  }

  if (
    typeof leaseId !== "string" ||
    leaseId.length === 0 ||
    leaseId !== leaseId.trim()
  ) {
    throw new TypeError(
      `Workspace provider "${providerName}" returned a lease with an invalid id`,
    )
  }

  const materialization: WorkspaceMaterializationReference =
    Object.freeze({
      directory,
      handle,
      leaseId,
      provider: Object.freeze({ name: providerName }),
      workspaceId,
    })

  return Object.freeze({
    materialization,
    release: capture.release,
    save: capture.save,
  })
}
