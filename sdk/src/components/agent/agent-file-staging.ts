import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { resolvePortablePath } from "../../core/resolve-portable-path.js"
import { HostFilesystem } from "../file/host-filesystem.js"
import type { SandboxSession } from "../sandbox/sandbox-provider.js"
import type { SandboxFileStaging } from "../sandbox/sandbox-runtime.js"

interface AgentFileStagingResource {
  readonly root: string
  writeFile(path: string, content: Uint8Array): Promise<void>
  release(): Promise<void>
}

/** Concrete Agent-visible location of one staged file. */
export interface AgentStagedFile {
  readonly directory: string
  readonly path: string
}

/**
 * Owns one lazily-created writable filesystem visible to a single Agent.
 *
 * Skill packages and oversized local Includes share this lifecycle. The root
 * is independent from durable Workspace state so read-only Sandboxes remain
 * usable and cleanup cannot accidentally publish transient authoring inputs.
 */
export class AgentFileStaging {
  #releasePromise: Promise<void> | undefined
  #resource: Promise<Readonly<AgentFileStagingResource>> | undefined
  readonly #sandbox: Readonly<SandboxSession> | undefined
  readonly #signal: AbortSignal

  /** Captures the execution environment without creating files eagerly. */
  constructor(sandbox: Readonly<SandboxSession> | undefined, signal: AbortSignal) {
    this.#sandbox = sandbox
    this.#signal = signal
  }

  /** Writes bytes under one portable relative path and returns its concrete location. */
  async writeFile(relativePath: string, content: Uint8Array): Promise<Readonly<AgentStagedFile>> {
    this.#signal.throwIfAborted()

    if (this.#releasePromise !== undefined) {
      throw new Error("Agent file staging is already being released")
    }

    const portablePath = resolvePortablePath(".", relativePath, "Agent staged file path")

    if (portablePath === ".") {
      throw new TypeError("Agent staged file path must identify a file")
    }

    const resource = await this.#getResource()
    await resource.writeFile(portablePath, Uint8Array.from(content))
    this.#signal.throwIfAborted()

    const stagedPath =
      this.#sandbox === undefined
        ? path.join(resource.root, ...portablePath.split("/"))
        : path.posix.join(resource.root, portablePath)

    return Object.freeze({
      directory: this.#sandbox === undefined ? path.dirname(stagedPath) : path.posix.dirname(stagedPath),
      path: stagedPath,
    })
  }

  /** Removes invocation-owned staging once, or does nothing when unused. */
  release(): Promise<void> {
    this.#releasePromise ??= this.#release()
    return this.#releasePromise
  }

  async #getResource(): Promise<Readonly<AgentFileStagingResource>> {
    this.#resource ??= this.#sandbox === undefined ? createHostStaging(this.#signal) : this.#createSandboxStaging()
    return await this.#resource
  }

  async #createSandboxStaging(): Promise<Readonly<AgentFileStagingResource>> {
    const staging = await this.#sandbox?.lease.runtime.createFileStaging({ signal: this.#signal })

    if (staging === undefined) {
      throw new Error("Agent Sandbox file staging could not be created")
    }

    return wrapSandboxStaging(staging, this.#signal)
  }

  async #release(): Promise<void> {
    const resource = this.#resource === undefined ? undefined : await this.#resource
    await resource?.release()
  }
}

async function createHostStaging(signal: AbortSignal): Promise<Readonly<AgentFileStagingResource>> {
  signal.throwIfAborted()
  const root = await mkdtemp(path.join(os.tmpdir(), "aml-agent-"))
  const filesystem = new HostFilesystem(root)
  let releasePromise: Promise<void> | undefined

  return Object.freeze({
    release: () => (releasePromise ??= rm(root, { force: true, recursive: true })),
    root,
    writeFile: async (relativePath: string, content: Uint8Array) => {
      await filesystem.writeFile(relativePath, content, { signal })
    },
  })
}

function wrapSandboxStaging(
  staging: Readonly<SandboxFileStaging>,
  signal: AbortSignal
): Readonly<AgentFileStagingResource> {
  return Object.freeze({
    release: async () => await staging.release(),
    root: staging.root,
    writeFile: async (relativePath: string, content: Uint8Array) => {
      await staging.writeFile(relativePath, content, { signal })
    },
  })
}
