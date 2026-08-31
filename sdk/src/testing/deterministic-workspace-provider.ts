import type {
  WorkspaceAcquireRequest,
  WorkspaceLease,
  WorkspaceProvider,
} from "../components/workspace/workspace-provider.js"
import { WorkspaceConflictError } from "../components/workspace/workspace-conflict-error.js"

/**
 * Default opaque handle exposed by the deterministic Workspace fixture.
 */
export interface DeterministicWorkspaceHandle {
  /** Zero-based acquisition order for this fixture instance. */
  readonly acquisition: number

  /** Stable default-handle discriminant. */
  readonly kind: "deterministic-workspace"

  /** Exact acquisition request recorded by the provider. */
  readonly request: WorkspaceAcquireRequest
}

/** Lease identity passed to deterministic Workspace lifecycle hooks. */
interface DeterministicWorkspaceLeaseIdentity<Handle> {
  /** Materialization directory exposed by the lease. */
  readonly directory: string

  /** Handle returned by the configured creation strategy. */
  readonly handle: Handle

  /** Deterministic lease id in `<provider-name>-<one-based-index>` form. */
  readonly id: string
}

/**
 * Configuration hooks for deterministic materialization and persistence.
 */
export interface DeterministicWorkspaceProviderOptions<Handle> {
  /**
   * Creates the provider-specific handle for an acquisition.
   *
   * Defaults to a {@link DeterministicWorkspaceHandle}. `acquisition` is the
   * zero-based call index.
   */
  readonly createHandle?: (request: WorkspaceAcquireRequest, acquisition: number) => Handle | PromiseLike<Handle>

  /**
   * Materialization directory or a per-acquisition directory strategy.
   *
   * Defaults to `"/deterministic-workspace"`.
   */
  readonly directory?: string | ((request: WorkspaceAcquireRequest, acquisition: number) => string)

  /**
   * Provider identifier used in lease ids.
   *
   * Defaults to `"deterministic-workspace"` and must be non-empty and trimmed.
   */
  readonly name?: string

  /**
   * Hook invoked during lease release before writer ownership is cleared.
   *
   * Defaults to a no-op. Ownership is still cleared when this hook rejects so
   * later tests cannot deadlock on fixture state.
   */
  readonly release?: (
    lease: Readonly<DeterministicWorkspaceLeaseIdentity<Handle>>,
    acquisition: number
  ) => void | PromiseLike<void>

  /**
   * Hook invoked when AML asks the lease to persist its materialization.
   *
   * Defaults to a no-op and runs after the lease id is recorded in `saves`.
   */
  readonly save?: (
    lease: Readonly<DeterministicWorkspaceLeaseIdentity<Handle>>,
    acquisition: number
  ) => void | PromiseLike<void>
}

/**
 * Records Workspace lifecycle calls and rejects concurrent writers by id.
 */
export class DeterministicWorkspaceProvider<
  Handle = DeterministicWorkspaceHandle,
> implements WorkspaceProvider<Handle> {
  readonly #acquisitions: WorkspaceAcquireRequest[] = []
  readonly #activeIds = new Map<string, symbol>()
  readonly #createHandle: (request: WorkspaceAcquireRequest, acquisition: number) => Handle | PromiseLike<Handle>
  readonly #directory: string | ((request: WorkspaceAcquireRequest, acquisition: number) => string)
  readonly #release: NonNullable<DeterministicWorkspaceProviderOptions<Handle>["release"]>
  readonly #releases: string[] = []
  readonly #save: NonNullable<DeterministicWorkspaceProviderOptions<Handle>["save"]>
  readonly #saves: string[] = []
  /** Stable provider identifier configured for this fixture. */
  readonly name: string

  /**
   * Captures deterministic hooks without materializing a Workspace.
   */
  constructor(options: DeterministicWorkspaceProviderOptions<Handle> = {}) {
    const name = options.name ?? "deterministic-workspace"

    if (name.length === 0 || name !== name.trim()) {
      throw new TypeError("Deterministic Workspace provider name must be non-empty and normalized")
    }

    this.name = name
    this.#directory = options.directory ?? "/deterministic-workspace"
    this.#createHandle =
      options.createHandle ??
      ((request, acquisition) =>
        ({
          acquisition,
          kind: "deterministic-workspace",
          request,
        }) as Handle)
    this.#release = options.release ?? (() => {})
    this.#save = options.save ?? (() => {})
  }

  /**
   * Returns acquisition requests in provider call order.
   */
  get acquisitions(): readonly WorkspaceAcquireRequest[] {
    return this.#acquisitions
  }

  /**
   * Returns lease ids in provider release order.
   */
  get releases(): readonly string[] {
    return this.#releases
  }

  /**
   * Returns lease ids in provider save order.
   */
  get saves(): readonly string[] {
    return this.#saves
  }

  /**
   * Acquires one deterministic exclusive writer lease.
   */
  async acquire(request: WorkspaceAcquireRequest): Promise<WorkspaceLease<Handle>> {
    if (this.#activeIds.has(request.id)) {
      throw new WorkspaceConflictError(request.id)
    }

    const ownership = Symbol(request.id)
    this.#activeIds.set(request.id, ownership)
    const acquisition = this.#acquisitions.length
    this.#acquisitions.push(request)
    let handle: Handle
    let directory: string

    try {
      handle = await this.#createHandle(request, acquisition)
      directory = typeof this.#directory === "function" ? this.#directory(request, acquisition) : this.#directory
    } catch (error) {
      // Acquisition has not returned a lease yet, so the provider—not the
      // caller—must roll back writer ownership when any fixture hook fails.
      if (this.#activeIds.get(request.id) === ownership) {
        this.#activeIds.delete(request.id)
      }
      throw error
    }

    const id = `${this.name}-${acquisition + 1}`
    const identity = Object.freeze({ directory, handle, id })

    return Object.freeze({
      ...identity,
      release: async () => {
        this.#releases.push(id)

        try {
          await this.#release(identity, acquisition)
        } finally {
          // Even a failed provider release must not make a deterministic test
          // deadlock every later acquisition of the same identity.
          if (this.#activeIds.get(request.id) === ownership) {
            this.#activeIds.delete(request.id)
          }
        }
      },
      save: async () => {
        this.#saves.push(id)
        await this.#save(identity, acquisition)
      },
    })
  }
}
