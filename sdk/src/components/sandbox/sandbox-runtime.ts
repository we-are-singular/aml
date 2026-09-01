import type { SandboxAccess, SandboxSession } from "./sandbox-provider.js"

/**
 * Per-command controls supported by every AML Sandbox runtime.
 *
 * `cwd` uses AML's logical Workspace namespace. The Sandbox provider maps it
 * to the corresponding host, container, or remote path.
 */
export interface SandboxExecOptions {
  /**
   * Normalized logical working directory for this command.
   *
   * Omission uses the runtime cwd. A supplied value must remain beneath the
   * acquired root.
   */
  readonly cwd?: string

  /** Command-specific string environment entries; omission supplies none. */
  readonly env?: Readonly<Record<string, string>>

  /**
   * Command-specific cancellation signal.
   *
   * Omission uses the Sandbox acquisition signal. Providers must propagate the
   * effective signal to process startup, execution, and cleanup.
   */
  readonly signal?: AbortSignal

  /** Optional positive timer-safe execution limit in milliseconds. */
  readonly timeoutMs?: number
}

/**
 * Completed output from one bounded Sandbox command.
 */
export interface SandboxExecResult {
  /** Process exit status; non-zero values are results rather than thrown errors. */
  readonly exitCode: number

  /** Bounded UTF-8 standard error captured after the process exits. */
  readonly stderr: string

  /** Bounded UTF-8 standard output captured after the process exits. */
  readonly stdout: string
}

/** Per-operation cancellation for portable Sandbox filesystem calls. */
export interface SandboxFileOptions {
  /** Caller-owned cancellation propagated to provider filesystem I/O. */
  readonly signal?: AbortSignal
}

/** Metadata for one regular file or directory beneath the Sandbox root. */
export interface SandboxFileStat {
  /** Entry kind after rejecting symbolic links and unsupported file types. */
  readonly kind: "directory" | "file"

  /** Encoded byte length for files; directories report `0`. */
  readonly size: number
}

/** Writable invocation-owned filesystem root visible to an Agent process. */
export interface SandboxFileStaging {
  /** Concrete provider path that Agents use when reading staged files. */
  readonly root: string

  /**
   * Writes one relative file beneath this unique staging root.
   *
   * Missing parents are created. The implementation must reject traversal,
   * symbolic-link escapes, and directory destinations.
   */
  writeFile(path: string, content: Uint8Array, options?: Readonly<SandboxFileOptions>): Promise<void>

  /** Removes this unique staging root. Repeated calls share one cleanup. */
  release(): Promise<void>
}

/**
 * Immutable completion state for one spawned Sandbox process.
 */
export interface SandboxProcessExit {
  /** Process exit status captured once for every `wait()` caller. */
  readonly exitCode: number
}

/**
 * Provider-neutral handle for one long-lived Sandbox process.
 *
 * Standard Web streams carry process input and output without imposing a
 * provider-specific PID or stdin API on callers.
 */
export interface SandboxProcess {
  /**
   * Opaque provider-defined execution identity used only for diagnostics.
   *
   * Consumers must not assume it is an operating-system PID.
   */
  readonly id: string

  /** Writable byte stream connected to process standard input. */
  readonly stdin: WritableStream<Uint8Array>

  /** Readable byte stream connected to process standard error. */
  readonly stderr: ReadableStream<Uint8Array>

  /** Readable byte stream connected to process standard output. */
  readonly stdout: ReadableStream<Uint8Array>

  /**
   * Terminates the process and its descendants. Repeated calls are safe.
   *
   * Resolution means the termination request completed; callers use `wait()`
   * to observe an actual process exit.
   */
  kill(): Promise<void>

  /**
   * Waits for completion and returns the same captured result on every call.
   *
   * Rejection means completion could not be observed and must not be interpreted
   * as proof that the process exited.
   */
  wait(): Promise<Readonly<SandboxProcessExit>>
}

/**
 * Minimal provider-neutral process and filesystem boundary for a Sandbox.
 *
 * Workspace attachment and Sandbox lifecycle remain provider responsibilities.
 * This contract exposes only the file operations required by AML authoring
 * primitives and Agent staging; images, snapshots, ports, and richer provider
 * filesystem APIs remain outside the portable surface.
 */
export interface SandboxRuntime {
  /** Filesystem authority this runtime actually enforces. */
  readonly access: SandboxAccess

  /** Normalized logical default working directory for commands. */
  readonly cwd: string

  /** Normalized logical root that command cwd values cannot escape. */
  readonly root: string

  /** Creates a writable Agent-visible root outside durable Workspace state. */
  createFileStaging(options?: Readonly<SandboxFileOptions>): Promise<Readonly<SandboxFileStaging>>

  /**
   * Executes one executable with literal arguments inside the Sandbox.
   *
   * `args` defaults to an empty array and `options` to inherited runtime values.
   * The promise resolves for ordinary non-zero process exits and rejects for
   * transport, cancellation, timeout, or output-bound failures.
   */
  exec(
    command: string,
    args?: readonly string[],
    options?: Readonly<SandboxExecOptions>
  ): Promise<Readonly<SandboxExecResult>>

  /** Reads one complete regular file beneath the logical Sandbox root. */
  readFile(path: string, options?: Readonly<SandboxFileOptions>): Promise<Uint8Array>

  /**
   * Starts one executable with literal arguments and streaming stdio.
   *
   * `args` defaults to an empty array and `options` to inherited runtime values.
   * The returned process must support repeat-safe termination and completion
   * observation for cleanup-sensitive Agent protocols.
   */
  spawn(
    command: string,
    args?: readonly string[],
    options?: Readonly<SandboxExecOptions>
  ): Promise<Readonly<SandboxProcess>>

  /** Returns metadata for one regular file or directory beneath the root. */
  stat(path: string, options?: Readonly<SandboxFileOptions>): Promise<Readonly<SandboxFileStat>>

  /** Atomically replaces one regular file beneath a read-write Sandbox root. */
  writeFile(path: string, content: Uint8Array, options?: Readonly<SandboxFileOptions>): Promise<void>
}

/**
 * Checks whether a lease runtime enforces an Agent's effective Sandbox view.
 *
 * The first runtime version supports Agent-local cwd changes but cannot
 * manufacture nested root or access narrowing after acquisition. The check is
 * structural: it requires the portable process and filesystem methods plus
 * exact root/access equality, but it does not prove deployment isolation,
 * credentials, or executable presence.
 */
export function supportsSandboxRuntime(session: SandboxSession): boolean {
  try {
    const runtime = session.lease.runtime

    return (
      typeof runtime === "object" &&
      runtime !== null &&
      typeof runtime.createFileStaging === "function" &&
      typeof runtime.exec === "function" &&
      typeof runtime.readFile === "function" &&
      typeof runtime.spawn === "function" &&
      typeof runtime.stat === "function" &&
      typeof runtime.writeFile === "function" &&
      runtime.root === session.root &&
      runtime.access === session.access
    )
  } catch {
    // Agent compatibility checks inspect provider-owned data and fail closed
    // when a malformed runtime cannot be read safely.
    return false
  }
}
