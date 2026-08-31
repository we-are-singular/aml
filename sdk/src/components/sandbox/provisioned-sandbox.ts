/**
 * Provider-owned environment after asynchronous provisioning succeeds.
 *
 * `AbstractSandboxProvider` receives this acknowledged resource and can
 * therefore compensate every later initialization failure.
 */
export interface ProvisionedSandbox<Handle, Resource> {
  /** Opaque descendant-facing identity exposed through the Sandbox lease. */
  readonly handle: Handle

  /** Stable non-empty lease identifier used for diagnostics and cleanup. */
  readonly id: string

  /** Provider-private resource needed to initialize, reconcile, and release. */
  readonly resource: Resource
}
