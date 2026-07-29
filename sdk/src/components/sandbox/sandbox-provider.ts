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
  readonly access: SandboxAccess
  readonly cwd: string
  readonly evaluationId: string
  readonly root: string
  readonly signal: AbortSignal
  readonly workspace?: Readonly<WorkspaceMaterializationReference>
}

/**
 * Provider-owned resource returned to AML for one Sandbox lifetime.
 *
 * The handle is deliberately opaque. AML carries it to compatible Agent
 * providers without assuming a command, process, or filesystem API.
 */
export interface SandboxLease<Handle = unknown> {
  readonly handle: Handle
  readonly id: string
  readonly runtime: SandboxRuntime

  /**
   * Releases every resource owned by this lease.
   */
  release(): Promise<void>
}

/**
 * Acquires provider-owned ephemeral execution environments.
 */
export interface SandboxProvider<Handle = unknown> {
  readonly name: string

  /**
   * Acquires one environment for an already validated portable policy.
   */
  acquire(request: SandboxAcquireRequest): Promise<SandboxLease<Handle>>
}

/**
 * Non-authoritative lease data visible to compatible descendants.
 */
export interface SandboxLeaseReference<Handle = unknown> {
  readonly handle: Handle
  readonly id: string
  readonly runtime: Readonly<SandboxRuntime>
}

/**
 * Stable provider identity visible without exposing acquisition authority.
 */
export interface SandboxProviderReference {
  readonly name: string
}

/**
 * Effective Sandbox policy and opaque lease inherited by an Agent.
 */
export interface SandboxSession<Handle = unknown> {
  readonly access: SandboxAccess
  readonly cwd: string
  readonly lease: SandboxLeaseReference<Handle>
  readonly nested: boolean
  readonly provider: SandboxProviderReference
  readonly root: string
}
