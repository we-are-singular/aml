/**
 * Opaque same-host materialization identity returned by the local provider.
 */
export interface LocalWorkspaceHandle {
  readonly directory: string
  readonly kind: "local-workspace"
}
