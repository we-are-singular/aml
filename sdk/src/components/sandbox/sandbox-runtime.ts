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
 * Minimal provider-neutral boundary used to start work in a Sandbox.
 *
 * Workspace attachment and Sandbox lifecycle remain provider responsibilities.
 * This contract deliberately does not expose portable filesystem, image,
 * snapshot, port, or background-process APIs.
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
      runtime.root === session.root &&
      runtime.access === session.access
    )
  } catch {
    // Agent compatibility checks inspect provider-owned data and fail closed
    // when a malformed runtime cannot be read safely.
    return false
  }
}
