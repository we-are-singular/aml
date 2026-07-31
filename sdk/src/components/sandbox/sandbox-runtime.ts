import type { SandboxAccess, SandboxSession } from "./sandbox-provider.js"

/**
 * Per-command controls supported by every AML Sandbox runtime.
 *
 * `cwd` uses AML's logical Workspace namespace. The Sandbox provider maps it
 * to the corresponding host, container, or remote path.
 */
export interface SandboxExecOptions {
  readonly cwd?: string
  readonly env?: Readonly<Record<string, string>>
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
}

/**
 * Completed output from one bounded Sandbox command.
 */
export interface SandboxExecResult {
  readonly exitCode: number
  readonly stderr: string
  readonly stdout: string
}

/**
 * Immutable completion state for one spawned Sandbox process.
 */
export interface SandboxProcessExit {
  readonly exitCode: number
}

/**
 * Provider-neutral handle for one long-lived Sandbox process.
 *
 * `id` is the portable identity. `pid` is present only when the provider can
 * expose a meaningful operating-system process id.
 */
export interface SandboxProcess {
  readonly id: string
  readonly pid?: number
  readonly stderr: ReadableStream<Uint8Array>
  readonly stdout: ReadableStream<Uint8Array>

  /**
   * Closes AML's writable side and requests the backend's stdin half-close.
   * Remote providers may expose only a closest signal rather than pipe EOF.
   * Repeated calls and calls after exit are no-ops.
   */
  closeInput(): Promise<void>

  /**
   * Terminates the process and its descendants. Repeated calls are safe.
   */
  kill(): Promise<void>

  /**
   * Waits for completion and returns the same captured result on every call.
   */
  wait(): Promise<Readonly<SandboxProcessExit>>

  /**
   * Writes bytes to standard input while the process is running.
   */
  write(data: Uint8Array): Promise<void>
}

/**
 * Minimal provider-neutral boundary used to start work in a Sandbox.
 *
 * Workspace attachment and Sandbox lifecycle remain provider responsibilities.
 * This contract deliberately does not expose portable filesystem, image,
 * snapshot, or port APIs.
 */
export interface SandboxRuntime {
  readonly access: SandboxAccess
  readonly cwd: string
  readonly root: string

  /**
   * Executes one executable with literal arguments inside the Sandbox.
   */
  exec(
    command: string,
    args?: readonly string[],
    options?: Readonly<SandboxExecOptions>
  ): Promise<Readonly<SandboxExecResult>>

  /**
   * Starts one executable with literal arguments and streaming stdio.
   */
  spawn(
    command: string,
    args?: readonly string[],
    options?: Readonly<SandboxExecOptions>
  ): Promise<Readonly<SandboxProcess>>
}

/**
 * Checks whether a lease runtime enforces an Agent's effective Sandbox view.
 *
 * The first runtime version supports Agent-local cwd changes but cannot
 * manufacture nested root or access narrowing after acquisition.
 */
export function supportsSandboxRuntime(session: SandboxSession): boolean {
  try {
    const runtime = session.lease.runtime

    return (
      typeof runtime === "object" &&
      runtime !== null &&
      typeof runtime.exec === "function" &&
      typeof runtime.spawn === "function" &&
      runtime.root === session.root &&
      runtime.access === session.access
    )
  } catch {
    // Agent compatibility checks inspect provider-owned data and fail closed
    // when a malformed runtime cannot be read safely.
    return false
  }
}
