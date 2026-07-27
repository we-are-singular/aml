/**
 * Provider-owned request for one durable Workspace materialization.
 */
export interface WorkspaceAcquireRequest {
  readonly evaluationId: string
  readonly id: string
  readonly signal: AbortSignal
}

/**
 * Provider-owned materialization and lifecycle authority returned to AML.
 */
export interface WorkspaceLease<Handle = unknown> {
  readonly directory: string
  readonly handle: Handle
  readonly id: string

  /**
   * Relinquishes locks and temporary materialization resources.
   */
  release(): Promise<void>

  /**
   * Persists the current materialization to its durable backend.
   */
  save(): Promise<void>
}

/**
 * Acquires exclusive writer access to one durable Workspace identity.
 *
 * A provider must reject another acquisition of the same id with
 * `WorkspaceConflictError` while the active lease retains healthy writer
 * authority. Renewable providers may instead report compromise after their
 * documented stale-recovery boundary. Scheduling complete evaluations belongs
 * above this boundary.
 */
export interface WorkspaceProvider<Handle = unknown> {
  readonly name: string

  /**
   * Materializes one durable Workspace or rejects an active-writer conflict.
   */
  acquire(
    request: WorkspaceAcquireRequest,
  ): Promise<WorkspaceLease<Handle>>
}

/**
 * Stable descriptive provider identity without acquisition authority.
 */
export interface WorkspaceProviderReference {
  readonly name: string
}

/**
 * Immutable active materialization passed only to outer Sandbox providers.
 *
 * The opaque handle may support provider-specific transfer optimizations.
 * Lifecycle methods remain private to AML.
 */
export interface WorkspaceMaterializationReference<Handle = unknown> {
  readonly directory: string
  readonly handle: Handle
  readonly leaseId: string
  readonly provider: WorkspaceProviderReference
  readonly workspaceId: string
}
