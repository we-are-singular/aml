import type { WorkspaceMaterializationReference } from "../workspace/workspace-provider.js"
import type { SandboxRuntime } from "./sandbox-runtime.js"

/**
 * Portable filesystem authority exposed by a Sandbox scope.
 */
export type SandboxAccess = "read-only" | "read-write"

/**
 * Validated policy supplied when AML acquires an outermost Sandbox.
 */
export interface SandboxAcquireRequest {
  /** Effective filesystem authority that the provider must enforce. */
  readonly access: SandboxAccess

  /** Normalized logical default cwd at or beneath `root`. */
  readonly cwd: string

  /** Unique identity of the AML evaluation acquiring this lease. */
  readonly evaluationId: string

  /** Normalized logical filesystem root visible to Sandbox descendants. */
  readonly root: string

  /** Evaluation signal covering acquisition and all lease-owned work. */
  readonly signal: AbortSignal

  /**
   * Active Workspace materialization to attach to the environment, when present.
   *
   * The reference exposes no save, release, or provider acquisition authority.
   */
  readonly workspace?: Readonly<WorkspaceMaterializationReference>
}

/**
 * Provider-owned resource returned to AML for one Sandbox lifetime.
 *
 * The handle is deliberately opaque. AML carries it to compatible Agent
 * providers without assuming a command, process, or filesystem API.
 */
export interface SandboxLease<Handle = unknown> {
  /** Opaque provider-defined value available to compatible Agent adapters. */
  readonly handle: Handle

  /** Stable non-empty identity for this acquired lease. */
  readonly id: string

  /** Provider-neutral command runtime enforcing the acquired effective policy. */
  readonly runtime: SandboxRuntime

  /**
   * Releases every resource owned by this lease.
   *
   * Calls must be safe to repeat. Release should terminate evaluation-owned
   * executions and relinquish authority even when reconciliation or deletion
   * encounters an error.
   */
  release(): Promise<void>
}

/**
 * Acquires provider-owned ephemeral execution environments.
 */
export interface SandboxProvider<Handle = unknown> {
  /** Non-empty normalized provider identifier used in errors and traces. */
  readonly name: string

  /**
   * Acquires one environment for an already validated portable policy.
   *
   * A pre-aborted signal must start no work. Once a lease is returned, AML calls
   * its release boundary after success, failure, or cancellation.
   */
  acquire(request: SandboxAcquireRequest): Promise<SandboxLease<Handle>>
}

/**
 * Non-authoritative lease data visible to compatible descendants.
 */
export interface SandboxLeaseReference<Handle = unknown> {
  /** Opaque provider-defined handle without release authority. */
  readonly handle: Handle

  /** Stable identity of the acquired outer lease. */
  readonly id: string

  /** Read-only provider-neutral execution runtime for the effective scope. */
  readonly runtime: Readonly<SandboxRuntime>
}

/**
 * Stable provider identity visible without exposing acquisition authority.
 */
export interface SandboxProviderReference {
  /** Stable provider name without access to its acquisition method. */
  readonly name: string
}

/**
 * Effective Sandbox policy and opaque lease inherited by an Agent.
 */
export interface SandboxSession<Handle = unknown> {
  /** Effective filesystem authority after all Sandbox nesting restrictions. */
  readonly access: SandboxAccess

  /** Effective normalized logical cwd for descendants. */
  readonly cwd: string

  /** Non-authoritative reference to the one acquired outer lease. */
  readonly lease: SandboxLeaseReference<Handle>

  /** Whether this session is a restricted view of an existing outer lease. */
  readonly nested: boolean

  /** Stable identity of the provider that acquired the outer lease. */
  readonly provider: SandboxProviderReference

  /** Effective normalized logical root after nesting restrictions. */
  readonly root: string
}
