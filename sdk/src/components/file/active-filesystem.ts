import path from "node:path"

import { EvaluationError } from "../../core/evaluation-error.js"
import { resolvePortablePath } from "../../core/resolve-portable-path.js"
import { HostFilesystem } from "./host-filesystem.js"
import type { SandboxSession } from "../sandbox/sandbox-provider.js"
import type { SandboxFileStat } from "../sandbox/sandbox-runtime.js"
import type { WorkspaceMaterializationReference } from "../workspace/workspace-provider.js"

/** Live filesystem selected by the nearest lexical Sandbox or Workspace. */
export class ActiveFilesystem {
  readonly #cacheNamespace: string
  readonly #host: HostFilesystem | undefined
  readonly #sandbox: Readonly<SandboxSession> | undefined

  private constructor(
    workspace: Readonly<WorkspaceMaterializationReference> | undefined,
    sandbox: Readonly<SandboxSession> | undefined
  ) {
    if (sandbox === undefined && workspace === undefined) {
      throw new Error("Active filesystem identity is unavailable")
    }

    this.#cacheNamespace =
      sandbox === undefined
        ? `workspace:${path.resolve(workspace!.directory)}`
        : `sandbox:${sandbox.lease.id}:${sandbox.root}`
    this.#sandbox = sandbox
    this.#host = sandbox === undefined && workspace !== undefined ? new HostFilesystem(workspace.directory) : undefined
  }

  /** Returns the stable namespace used to distinguish cached file revisions. */
  cacheNamespace(): string {
    return this.#cacheNamespace
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

  /** Maps a resolved Sandbox file path from the effective Agent cwd. */
  agentReadablePath(portablePath: string): string | undefined {
    if (this.#sandbox === undefined) {
      return undefined
    }

    const relativePath = path.posix.relative(this.#sandbox.cwd, portablePath)
    return relativePath.length === 0 ? portablePath : relativePath
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

  #requiredHost(): HostFilesystem {
    if (this.#host === undefined) {
      throw new Error("Active host filesystem is unavailable")
    }

    return this.#host
  }
}
