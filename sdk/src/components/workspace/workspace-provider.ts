/** Normalized revision selection passed from `Workspace` to its provider. */
export interface WorkspaceLoadRequest {
  /** Relative globs excluded from restoration; empty means no exclusions. */
  readonly exclude: readonly string[]

  /** Relative globs limiting restored files; omission selects all files. */
  readonly include?: readonly string[]

  /** `"current"` or one non-empty provider revision identifier to restore. */
  readonly revision: "current" | string
}

/**
 * Provider-owned request for one durable Workspace materialization.
 */
export interface WorkspaceAcquireRequest {
  /** Unique identity of the AML evaluation requesting materialization. */
  readonly evaluationId: string

  /** Non-empty normalized durable Workspace identity. */
  readonly id: string

  /**
   * Revision load policy.
   *
   * `false` requests an empty materialization; an object requests one revision.
   * AML runtime calls provide one of those normalized forms.
   */
  readonly load?: false | WorkspaceLoadRequest

  /** Whether the provider should acquire writer authority; defaults to `true`. */
  readonly lock?: boolean

  /** Whether AML may later call `save` for this lease. */
  readonly save?: boolean

  /** Evaluation signal covering acquisition and materialization work. */
  readonly signal: AbortSignal
}

/** Complete normalized publication request passed to a Workspace lease. */
export interface WorkspaceSaveRequest {
  /** Relative globs excluded from publication; empty means none. */
  readonly exclude: readonly string[]

  /** Whether `.gitignore` rules participate in snapshot selection. */
  readonly gitignore: boolean

  /** Relative globs limiting publication; omission considers all files. */
  readonly include?: readonly string[]

  /** Outcome of descendant evaluation that triggered this save policy. */
  readonly outcome: "failure" | "success"

  /** Positive number of revisions retained, including the newly published one. */
  readonly retention: number

  /** Evaluation signal that must remain active throughout publication. */
  readonly signal: AbortSignal
}

/**
 * Provider-owned materialization and lifecycle authority returned to AML.
 */
export interface WorkspaceLease<Handle = unknown> {
  /** Runtime-visible materialized directory observed by descendants. */
  readonly directory: string

  /** Opaque provider data for compatible Sandbox transfer or mounting. */
  readonly handle: Handle

  /** Stable non-empty identity of this acquired materialization lease. */
  readonly id: string

  /**
   * Relinquishes locks and temporary materialization resources.
   *
   * Calls must be safe to repeat and must relinquish authority even if cleanup
   * or provider reconciliation reports an error.
   */
  release(): Promise<void>

  /**
   * Persists the current materialization to its durable backend.
   *
   * AML passes a normalized request when saving an authored Workspace. The
   * optional argument preserves the low-level provider seam; implementations
   * should document their defaults for direct calls.
   */
  save(request?: WorkspaceSaveRequest): Promise<void>
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
  /** Non-empty normalized provider identifier used in errors and references. */
  readonly name: string

  /**
   * Materializes one durable Workspace or rejects an active-writer conflict.
   *
   * A pre-aborted signal must start no work. Partial materialization failures
   * must release any acquired lock or temporary resource before rejecting.
   */
  acquire(request: WorkspaceAcquireRequest): Promise<WorkspaceLease<Handle>>
}

/**
 * Stable descriptive provider identity without acquisition authority.
 */
export interface WorkspaceProviderReference {
  /** Stable descriptive provider name without acquisition authority. */
  readonly name: string
}

/**
 * Immutable active materialization passed only to outer Sandbox providers.
 *
 * The opaque handle may support provider-specific transfer optimizations.
 * Lifecycle methods remain private to AML.
 */
export interface WorkspaceMaterializationReference<Handle = unknown> {
  /** Normalized logical cwd selected by the authored Workspace. */
  readonly cwd: string

  /** Runtime-visible materialization directory to attach or synchronize. */
  readonly directory: string

  /** Opaque provider data available for compatible transfer optimizations. */
  readonly handle: Handle

  /** Identity of this acquired materialization lease. */
  readonly leaseId: string

  /** Descriptive provider identity without `acquire` authority. */
  readonly provider: WorkspaceProviderReference

  /** Authored durable Workspace identity shared across revisions and retries. */
  readonly workspaceId: string

  /** Writable sibling-Sandbox coordination policy selected by the Workspace. */
  readonly writeConcurrency: "parallel" | "serial"
}
