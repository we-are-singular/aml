import type { SandboxAcquireRequest, SandboxLease, SandboxProvider } from "./sandbox-provider.js"
import type { ProvisionedSandbox } from "./provisioned-sandbox.js"
import type { SandboxRuntime } from "./sandbox-runtime.js"

/**
 * Template implementation for staged Sandbox acquisition and release.
 *
 * Subclasses own environment creation, runtime translation, initialization,
 * reconciliation, and destruction. This base compensates every failure after
 * provisioning and exposes one idempotent lease release barrier.
 */
export abstract class AbstractSandboxProvider<
  Name extends string,
  Handle,
  Resource,
> implements SandboxProvider<Handle> {
  /** Stable non-empty normalized provider identifier used in diagnostics. */
  readonly name: Name

  /** Creates a staged provider base while retaining the literal name type. */
  protected constructor(name: Name) {
    this.name = name
  }

  /**
   * Provisions, initializes, and returns one immutable Sandbox lease.
   *
   * A pre-aborted request starts no work. Any failure after `provision` resolves
   * is compensated through `cleanupProvisioned`; the returned `release` caches
   * the complete `releaseResource` operation.
   */
  async acquire(request: SandboxAcquireRequest): Promise<SandboxLease<Handle>> {
    request.signal.throwIfAborted()
    const provisioned = await this.provision(request)

    let runtime: Readonly<SandboxRuntime>

    try {
      request.signal.throwIfAborted()
      runtime = this.createRuntime(provisioned, request)
      await this.initialize(provisioned, runtime, request)
      request.signal.throwIfAborted()
    } catch (error) {
      try {
        await this.cleanupProvisioned(provisioned, request)
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          `Sandbox provider "${this.name}" acquisition and cleanup failed`
        )
      }

      throw error
    }

    let releasePromise: Promise<void> | undefined

    return Object.freeze({
      handle: provisioned.handle,
      id: provisioned.id,
      release: () => (releasePromise ??= this.releaseResource(provisioned, request)),
      runtime,
    })
  }

  /**
   * Creates the provider resource. Partial creation cleanup remains local to
   * this hook because the base cannot reclaim a resource it never receives.
   */
  protected abstract provision(request: SandboxAcquireRequest): Promise<Readonly<ProvisionedSandbox<Handle, Resource>>>

  /**
   * Builds the narrow runtime over one successfully provisioned environment.
   *
   * The runtime must enforce the request's effective access, root, cwd, literal
   * argument semantics, cancellation, output bounds, and process cleanup.
   */
  protected abstract createRuntime(
    provisioned: Readonly<ProvisionedSandbox<Handle, Resource>>,
    request: SandboxAcquireRequest
  ): Readonly<SandboxRuntime>

  /**
   * Performs post-provision setup before the lease becomes visible.
   *
   * The default performs no setup. Overrides may hydrate a Workspace or run
   * trusted configuration and should honor `request.signal`.
   */
  protected async initialize(
    _provisioned: Readonly<ProvisionedSandbox<Handle, Resource>>,
    _runtime: Readonly<SandboxRuntime>,
    _request: SandboxAcquireRequest
  ): Promise<void> {}

  /**
   * Compensates failed initialization without assuming successful evaluation.
   *
   * The default delegates to `releaseResource`; override only when a partially
   * initialized resource requires a different cleanup path.
   */
  protected async cleanupProvisioned(
    provisioned: Readonly<ProvisionedSandbox<Handle, Resource>>,
    request: SandboxAcquireRequest
  ): Promise<void> {
    await this.releaseResource(provisioned, request)
  }

  /**
   * Reconciles and releases one successfully exposed provider resource.
   *
   * Implementations must release evaluation-owned executions and authority even
   * when reconciliation fails. Shared durable infrastructure need not be
   * destroyed, but this evaluation's lease must end.
   */
  protected abstract releaseResource(
    provisioned: Readonly<ProvisionedSandbox<Handle, Resource>>,
    request: SandboxAcquireRequest
  ): Promise<void>
}
