/**
 * Reports an intentional exclusive-writer conflict for one Workspace id.
 *
 * The stable code and id let conformance recognize errors across physical SDK
 * copies without mistaking unrelated provider failures for lock contention.
 */
export class WorkspaceConflictError extends Error {
  /** Stable cross-package error code for a healthy active-writer conflict. */
  readonly code = "AML_WORKSPACE_CONFLICT"

  /** Stable JavaScript error name. */
  override readonly name = "WorkspaceConflictError"

  /** Durable Workspace identity whose active writer blocked acquisition. */
  readonly workspaceId: string

  /**
   * Identifies the durable Workspace whose active writer rejected acquisition.
   *
   * Use this error only for healthy competing writer authority. Stale
   * publication, storage, authorization, corruption, and cleanup failures retain
   * their own error identity.
   */
  constructor(workspaceId: string) {
    super(`Workspace "${workspaceId}" already has an active writer`)
    this.workspaceId = workspaceId
  }

  /**
   * Recognizes the public structural contract across duplicated SDK packages.
   *
   * When `workspaceId` is supplied, the candidate must match that exact durable
   * identity in addition to carrying the stable code.
   */
  static is(value: unknown, workspaceId?: string): value is WorkspaceConflictError {
    if (typeof value !== "object" || value === null) {
      return false
    }

    let code: unknown
    let capturedWorkspaceId: unknown

    try {
      const candidate = value as {
        readonly code?: unknown
        readonly workspaceId?: unknown
      }
      // Read provider-controlled fields once so getters cannot change the
      // classification between validation and comparison.
      code = candidate.code
      capturedWorkspaceId = candidate.workspaceId
    } catch {
      return false
    }

    return (
      code === "AML_WORKSPACE_CONFLICT" &&
      typeof capturedWorkspaceId === "string" &&
      (workspaceId === undefined || capturedWorkspaceId === workspaceId)
    )
  }
}
