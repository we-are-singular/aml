import { randomUUID } from "node:crypto"
import { realpath, stat } from "node:fs/promises"

import lockfile from "proper-lockfile"

import {
  defineWorkspaceProvider,
  WorkspaceConflictError,
  type WorkspaceAcquireRequest,
  type WorkspaceLease,
  type WorkspaceProvider,
} from "@aml-jsx/sdk"

import type { LocalWorkspaceHandle } from "./local-workspace-handle.js"
import {
  parseLocalWorkspaceOptions,
  type LocalWorkspaceOptions,
  type ParsedLocalWorkspaceOptions,
} from "./local-workspace-options.js"

const LOCK_STALE_MS = 20 * 60 * 1_000
const LOCK_UPDATE_MS = 5 * 60 * 1_000

export type { LocalWorkspaceHandle } from "./local-workspace-handle.js"
export type { LocalWorkspaceOptions } from "./local-workspace-options.js"

/**
 * Creates a lazy provider for one existing durable local directory.
 *
 * The directory itself is the materialization, so changes are already durable
 * and `save()` acts only as a lock-health barrier. Acquisitions request an
 * exclusive renewable cross-process lock by default; `<Workspace lock={false}>`
 * opts out for application-coordinated access.
 *
 * @param options Existing host directory to expose directly.
 */
export function localWorkspace(options: LocalWorkspaceOptions): Readonly<WorkspaceProvider<LocalWorkspaceHandle>> {
  return defineWorkspaceProvider(new LocalWorkspaceProvider(parseLocalWorkspaceOptions(options)))
}

/**
 * Owns physical directory validation and cross-process writer locking.
 */
class LocalWorkspaceProvider implements WorkspaceProvider<LocalWorkspaceHandle> {
  readonly #options: Readonly<ParsedLocalWorkspaceOptions>
  readonly name = "local"

  /**
   * Captures validated configuration without touching the filesystem.
   */
  constructor(options: Readonly<ParsedLocalWorkspaceOptions>) {
    this.#options = options
  }

  /**
   * Resolves and exclusively locks the configured local materialization.
   */
  async acquire(request: WorkspaceAcquireRequest): Promise<WorkspaceLease<LocalWorkspaceHandle>> {
    request.signal.throwIfAborted()
    const directory = await this.#resolveDirectory(request.signal)

    if (request.lock === false) {
      return createLocalWorkspaceLease(directory)
    }

    const activeLock = new LocalWorkspaceLock(directory)

    try {
      const releaseLock = await lockfile.lock(directory, {
        onCompromised(error) {
          // Background lock refresh cannot throw into the active evaluation.
          // Save observes the first compromise at AML's lifecycle boundary.
          activeLock.markCompromised(error)
        },
        realpath: false,
        retries: 0,
        stale: LOCK_STALE_MS,
        update: LOCK_UPDATE_MS,
      })
      activeLock.attach(releaseLock)
    } catch (cause) {
      request.signal.throwIfAborted()

      if (hasErrorCode(cause, "ELOCKED")) {
        throw new WorkspaceConflictError(request.id)
      }

      throw new Error(`Local Workspace "${directory}" lock acquisition failed`, { cause })
    }

    if (request.signal.aborted) {
      try {
        // Cancellation raced with acquisition. Use the same cleanup path as a
        // live lease so compromise and dependency failures stay attributed.
        await activeLock.release()
      } catch (releaseError) {
        throw new AggregateError(
          [request.signal.reason, releaseError],
          "Local Workspace acquisition was cancelled and lock cleanup failed"
        )
      }

      throw request.signal.reason
    }

    return createLocalWorkspaceLease(directory, activeLock)
  }

  /**
   * Resolves symlinks once and requires one existing directory.
   */
  async #resolveDirectory(signal: AbortSignal): Promise<string> {
    let directory: string

    try {
      directory = await realpath(this.#options.directory)
      signal.throwIfAborted()
      const metadata = await stat(directory)
      signal.throwIfAborted()

      if (!metadata.isDirectory()) {
        throw new TypeError("Local Workspace materialization must be a directory")
      }
    } catch (cause) {
      signal.throwIfAborted()
      throw new Error(`Local Workspace "${this.#options.directory}" cannot be materialized`, { cause })
    }

    return directory
  }
}

/**
 * Owns proper-lockfile's unusual compromise and release lifecycle.
 */
class LocalWorkspaceLock {
  readonly #directory: string
  #compromise: Error | undefined
  #compromiseReported = false
  #release: Promise<void> | undefined
  #releaseLock: (() => Promise<void>) | undefined

  constructor(directory: string) {
    this.#directory = directory
  }

  /**
   * Attaches the dependency release function after acquisition succeeds.
   */
  attach(releaseLock: () => Promise<void>): void {
    this.#releaseLock = releaseLock
  }

  /**
   * Captures the first heartbeat failure for the next AML lifecycle boundary.
   */
  markCompromised(cause: Error): void {
    this.#compromise ??= cause
  }

  /**
   * Verifies that durable writes still happen under an owned lock.
   */
  assertHealthy(): void {
    if (this.#compromise === undefined) {
      return
    }

    this.#compromiseReported = true
    throw createCompromiseError(this.#directory, this.#compromise)
  }

  /**
   * Releases exactly once and reports any previously unseen compromise.
   */
  release(): Promise<void> {
    this.#release ??= this.#releaseOnce()
    return this.#release
  }

  /**
   * Normalizes proper-lockfile's release behavior into AML-owned errors.
   */
  async #releaseOnce(): Promise<void> {
    const compromiseBeforeRelease = this.#compromise

    // proper-lockfile marks a compromised lock released before invoking its
    // callback. Do not call that now-invalid release function.
    if (compromiseBeforeRelease !== undefined) {
      this.#throwUnreportedCompromise(compromiseBeforeRelease)
      return
    }

    if (this.#releaseLock === undefined) {
      throw new Error(`Local Workspace "${this.#directory}" lock was not acquired`)
    }

    try {
      await this.#releaseLock()
    } catch (cause) {
      const compromiseAfterFailure = this.#compromise

      if (compromiseAfterFailure !== undefined) {
        this.#throwUnreportedCompromise(compromiseAfterFailure)
        return
      }

      throw new Error(`Local Workspace "${this.#directory}" lock release failed`, { cause })
    }

    if (this.#compromise !== undefined) {
      this.#throwUnreportedCompromise(this.#compromise)
    }
  }

  /**
   * Reports compromise once so save followed by release does not duplicate it.
   */
  #throwUnreportedCompromise(cause: Error): void {
    if (this.#compromiseReported) {
      return
    }

    this.#compromiseReported = true
    throw createCompromiseError(this.#directory, cause)
  }
}

/**
 * Creates one idempotently releasable lease over a direct local directory.
 */
function createLocalWorkspaceLease(
  directory: string,
  activeLock?: LocalWorkspaceLock
): Readonly<WorkspaceLease<LocalWorkspaceHandle>> {
  const handle: LocalWorkspaceHandle = Object.freeze({
    directory,
    kind: "local-workspace",
  })
  const id = `local-${randomUUID()}`

  return Object.freeze({
    directory,
    handle,
    id,
    release() {
      return activeLock?.release() ?? Promise.resolve()
    },
    async save() {
      // The materialization is direct: filesystem writes are already durable,
      // so save is a lock-health barrier rather than a copy operation.
      activeLock?.assertHealthy()
    },
  })
}

/**
 * Attributes renewable-lock failure without leaking dependency error wording.
 */
function createCompromiseError(directory: string, cause: Error): Error {
  return new Error(`Local Workspace "${directory}" lock was compromised`, { cause })
}

/**
 * Reads library error codes without trusting arbitrary thrown accessors.
 */
function hasErrorCode(value: unknown, code: string): boolean {
  if (typeof value !== "object" || value === null) {
    return false
  }

  try {
    return "code" in value && (value as { readonly code?: unknown }).code === code
  } catch {
    return false
  }
}
