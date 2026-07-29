/**
 * Provider-owned environment after asynchronous provisioning succeeds.
 *
 * `AbstractSandboxProvider` receives this acknowledged resource and can
 * therefore compensate every later initialization failure.
 */
export interface ProvisionedSandbox<Handle, Resource> {
  readonly handle: Handle
  readonly id: string
  readonly resource: Resource
}
