/**
 * Opaque same-host materialization identity returned by the local provider.
 */
export interface LocalWorkspaceHandle {
  /** Canonical host path of the acquired Workspace materialization. */
  readonly directory: string

  /** Stable provider-handle discriminant. */
  readonly kind: "local-workspace"
}
