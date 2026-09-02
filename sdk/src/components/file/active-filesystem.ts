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
    sandbox: Readonly<SandboxSession> | undefined,
    cacheNamespace: string
  ) {
    this.#cacheNamespace = cacheNamespace
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
    if (sandbox !== undefined) {
      return new ActiveFilesystem(workspace, sandbox, `sandbox:${sandbox.lease.id}:${sandbox.root}`)
    }
    if (workspace !== undefined) {
      return new ActiveFilesystem(workspace, undefined, `workspace:${path.resolve(workspace.directory)}`)
    }
    return undefined
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

  /** Opens one file as chunks without retaining its complete body. */
  async readFileChunks(path: string, signal: AbortSignal): Promise<AsyncIterable<Uint8Array>> {
    signal.throwIfAborted()
    const sandbox = this.#sandbox

    if (sandbox === undefined) {
      return await this.#requiredHost().readFileChunks(path, { signal })
    }

    // Some providers intentionally reject every process under read-only access
    // because their execution boundary cannot enforce a read-only filesystem.
    // Preserve that security contract by using the provider's complete file
    // read there; read-write Sandboxes can stream through the process RPC.
    if (sandbox.access === "read-only") {
      return chunksFrom(await sandbox.lease.runtime.readFile(path, { signal }))
    }

    const commandPath = this.agentReadablePath(path)
    if (commandPath === undefined) throw new Error("Active Sandbox path is not Agent-readable")
    return this.#readSandboxFileChunks(sandbox, path, commandPath, signal)
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

  /**
   * Bridges SandboxRuntime's process streams into the filesystem chunk API.
   *
   * SandboxRuntime intentionally exposes complete `readFile()` snapshots but
   * no file-stream primitive. `cat` receives the path as a literal argument;
   * stdout is consumed lazily while stderr and process cleanup remain owned by
   * this filesystem boundary.
   */
  async *#readSandboxFileChunks(
    sandbox: Readonly<SandboxSession>,
    path: string,
    commandPath: string,
    signal: AbortSignal
  ): AsyncIterable<Uint8Array> {
    const process = await sandbox.lease.runtime.spawn("cat", [commandPath], {
      cwd: sandbox.cwd,
      signal,
    })
    const stderr = readText(process.stderr)

    try {
      const writer = process.stdin.getWriter()
      try {
        await writer.close()
      } finally {
        writer.releaseLock()
      }

      for await (const chunk of process.stdout) yield chunk

      const [errorOutput, exit] = await Promise.all([stderr, process.wait()])
      if (exit.exitCode !== 0) {
        throw new Error(`Sandbox could not read "${path}": ${errorOutput || `cat exited ${exit.exitCode}`}`)
      }
    } finally {
      // SandboxProcess.kill() is repeat-safe, including after normal exit. A
      // finally block also covers consumers that stop after a decode error or
      // cancellation, which invokes generator return rather than catch.
      await process.kill()
      await stderr.catch(() => undefined)
    }
  }
}

async function readText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder()
  let output = ""

  for await (const chunk of stream) output += decoder.decode(chunk, { stream: true })
  return `${output}${decoder.decode()}`.trim()
}

async function* chunksFrom(content: Uint8Array): AsyncIterable<Uint8Array> {
  yield content
}
