import { EvaluationError } from "../../core/evaluation-error.js"
import { resolvePortablePath } from "../../core/resolve-portable-path.js"
import { HostSandboxFileSystem } from "../sandbox/host-sandbox-filesystem.js"
import type { SandboxSession } from "../sandbox/sandbox-provider.js"
import type { SandboxFileStat } from "../sandbox/sandbox-runtime.js"
import type { WorkspaceMaterializationReference } from "../workspace/workspace-provider.js"

/** Live filesystem selected by the nearest lexical Sandbox or Workspace. */
export class ActiveFilesystem {
  readonly #host: HostSandboxFileSystem | undefined
  readonly #sandbox: Readonly<SandboxSession> | undefined

  private constructor(
    workspace: Readonly<WorkspaceMaterializationReference> | undefined,
    sandbox: Readonly<SandboxSession> | undefined
  ) {
    this.#sandbox = sandbox
    this.#host =
      sandbox === undefined && workspace !== undefined ? new HostSandboxFileSystem(workspace.directory) : undefined
  }

  /** Selects Sandbox guest first, then Workspace materialization. */
  static capture(
    workspace: Readonly<WorkspaceMaterializationReference> | undefined,
    sandbox: Readonly<SandboxSession> | undefined
  ): ActiveFilesystem | undefined {
    return sandbox === undefined && workspace === undefined ? undefined : new ActiveFilesystem(workspace, sandbox)
  }

  /** Validates one authored path before any child AML or filesystem effect. */
  resolvePath(value: unknown, label: string): string {
    const root = this.#sandbox?.root ?? "."
    const portablePath = resolvePortablePath(root, value, label)

    if (portablePath === root) {
      throw new EvaluationError(`${label} must identify a file`)
    }

    return portablePath
  }

  /** Reads one complete byte snapshot from the selected live filesystem. */
  async readFile(path: string, signal: AbortSignal): Promise<Uint8Array> {
    signal.throwIfAborted()

    return this.#sandbox === undefined
      ? await this.#requiredHost().readFile(path, { signal })
      : await this.#sandbox.lease.runtime.readFile(path, { signal })
  }

  /** Reads metadata without loading the complete file body. */
  async stat(path: string, signal: AbortSignal): Promise<Readonly<SandboxFileStat>> {
    signal.throwIfAborted()

    return this.#sandbox === undefined
      ? await this.#requiredHost().stat(path, { signal })
      : await this.#sandbox.lease.runtime.stat(path, { signal })
  }

  /** Replaces one file only when the selected scope is writable. */
  async writeFile(path: string, content: Uint8Array, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()

    if (this.#sandbox?.access === "read-only") {
      throw new EvaluationError("<File> cannot write inside a read-only <Sandbox>")
    }

    if (this.#sandbox === undefined) {
      await this.#requiredHost().writeFile(path, content, { signal })
      return
    }

    await this.#sandbox.lease.runtime.writeFile(path, content, { signal })
  }

  #requiredHost(): HostSandboxFileSystem {
    if (this.#host === undefined) {
      throw new Error("Active host filesystem is unavailable")
    }

    return this.#host
  }
}
