import { createHash, randomUUID } from "node:crypto"
import { createReadStream, createWriteStream } from "node:fs"
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises"
import path from "node:path"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"

import {
  createPersistentWorkspaceProvider,
  workspaceStorageSegment,
  WorkspaceConflictError,
  type PersistentWorkspaceHandle,
  type WorkspacePersistenceFormat,
  type WorkspaceProvider,
  type WorkspaceStorageAcquireRequest,
  type WorkspaceStorageAdapter,
  type WorkspaceStorageBody,
  type WorkspaceStorageLease,
  type WorkspaceStorageObject,
  type WorkspaceStorageWriteOptions,
} from "@aml-jsx/sdk"
import lockfile from "proper-lockfile"

const LOCK_STALE_MS = 20 * 60 * 1_000
const LOCK_UPDATE_MS = 5 * 60 * 1_000

/** Durable local storage root for {@link FilesystemWorkspaceStorage}. */
export interface FilesystemWorkspaceStorageOptions {
  /**
   * Host directory under which revision objects and indexes are stored.
   *
   * The path is resolved during construction. It need not exist yet; storage
   * namespaces are created lazily during acquisition.
   */
  readonly directory: string
}

/**
 * Configuration for a staged, revisioned Workspace persisted on this host.
 */
export interface FilesystemWorkspaceOptions extends FilesystemWorkspaceStorageOptions {
  /**
   * Representation used for new revisions.
   *
   * Defaults to `"archive"`; `"folder"` stores selected files as individual
   * objects. Existing revisions retain and restore their recorded format.
   */
  readonly format?: WorkspacePersistenceFormat

  /**
   * Maximum compressed archive size accepted while saving or restoring.
   *
   * Defaults to `268_435_456` bytes (256 MiB) and must be a positive safe integer.
   */
  readonly maxArchiveBytes?: number

  /**
   * Maximum number of selected archive entries, including the root where used.
   *
   * Defaults to `100_000` and must be a positive safe integer.
   */
  readonly maxEntries?: number

  /**
   * Maximum total uncompressed bytes selected for one revision.
   *
   * Defaults to `1_073_741_824` bytes (1 GiB) and must be a positive safe integer.
   */
  readonly maxExtractedBytes?: number

  /**
   * Parent directory for temporary per-acquisition materializations and archives.
   *
   * Defaults to `os.tmpdir()` and is resolved during provider construction.
   */
  readonly temporaryDirectory?: string
}

/** Storage-layer identity exposed inside a Filesystem Workspace handle. */
export interface FilesystemWorkspaceStorageHandle {
  /** Host directory containing the acquired logical Workspace's storage objects. */
  readonly directory: string

  /** Stable storage-handle discriminant. */
  readonly kind: "filesystem-workspace"
}

/**
 * Persistent Workspace handle containing its staging directory, revision
 * metadata, and {@link FilesystemWorkspaceStorageHandle}.
 */
export type FilesystemWorkspaceHandle = PersistentWorkspaceHandle<FilesystemWorkspaceStorageHandle>

/**
 * Creates a safe staged Workspace whose revision store lives on this host.
 *
 * Each acquisition restores into a temporary directory, and configured saves
 * publish an immutable revision plus a compare-and-swap index update. This is
 * distinct from `localWorkspace()`, which exposes a directory directly.
 *
 * @param options Durable storage root, revision format, staging path, and limits.
 */
export function filesystemWorkspace(
  options: FilesystemWorkspaceOptions
): Readonly<WorkspaceProvider<FilesystemWorkspaceHandle>> {
  const storage = new FilesystemWorkspaceStorage(options)

  return createPersistentWorkspaceProvider({
    ...(options.format === undefined ? {} : { format: options.format }),
    ...(options.maxArchiveBytes === undefined ? {} : { maxArchiveBytes: options.maxArchiveBytes }),
    ...(options.maxEntries === undefined ? {} : { maxEntries: options.maxEntries }),
    ...(options.maxExtractedBytes === undefined ? {} : { maxExtractedBytes: options.maxExtractedBytes }),
    storage,
    ...(options.temporaryDirectory === undefined ? {} : { temporaryDirectory: options.temporaryDirectory }),
  })
}

/**
 * Maps Workspace persistence operations to atomic local filesystem writes.
 */
export class FilesystemWorkspaceStorage implements WorkspaceStorageAdapter<FilesystemWorkspaceStorageHandle> {
  readonly #directory: string

  /** Stable storage-adapter name included in provider references. */
  readonly name = "filesystem"

  /**
   * Captures and resolves a durable local storage root without creating it.
   *
   * @param options Directory beneath which logical Workspace namespaces live.
   */
  constructor(options: FilesystemWorkspaceStorageOptions) {
    if (typeof options !== "object" || options === null) {
      throw new TypeError("Filesystem Workspace options must be an object")
    }

    if (
      typeof options.directory !== "string" ||
      options.directory.length === 0 ||
      options.directory !== options.directory.trim()
    ) {
      throw new TypeError("Filesystem Workspace directory must be a non-empty normalized string")
    }

    this.#directory = path.resolve(options.directory)
  }

  /**
   * Opens one logical Workspace namespace and optionally acquires its renewable
   * cross-process writer lock.
   *
   * The returned lease implements atomic object replacement and conditional
   * index writes. A held lock is released idempotently through `lease.release()`.
   */
  async acquire(
    request: WorkspaceStorageAcquireRequest
  ): Promise<WorkspaceStorageLease<FilesystemWorkspaceStorageHandle>> {
    request.signal.throwIfAborted()
    const root = path.join(this.#directory, workspaceStorageSegment(request.id))
    await mkdir(root, { recursive: true })
    let compromise: Error | undefined
    let releaseLock: (() => Promise<void>) | undefined

    if (request.lock) {
      try {
        releaseLock = await lockfile.lock(root, {
          onCompromised(error) {
            compromise ??= error
          },
          realpath: false,
          retries: 0,
          stale: LOCK_STALE_MS,
          update: LOCK_UPDATE_MS,
        })
      } catch (cause) {
        request.signal.throwIfAborted()

        if (hasErrorCode(cause, "ELOCKED")) {
          throw new WorkspaceConflictError(request.id)
        }

        throw new Error(`Filesystem Workspace "${request.id}" lock acquisition failed`, { cause })
      }
    }

    let release: Promise<void> | undefined
    const assertHealthy = () => {
      if (compromise !== undefined) {
        throw new Error(`Filesystem Workspace "${request.id}" lock was compromised`, {
          cause: compromise,
        })
      }
    }
    const lease: WorkspaceStorageLease<FilesystemWorkspaceStorageHandle> = {
      delete: async paths => {
        for (const objectPath of [...paths].sort((left, right) => right.length - left.length)) {
          await rm(resolveStoragePath(root, objectPath), { force: true, recursive: true })
        }
      },
      handle: Object.freeze({
        directory: root,
        kind: "filesystem-workspace" as const,
      }),
      list: async prefix => {
        const start = resolveStoragePath(root, prefix)

        try {
          const metadata = await stat(start)

          if (!metadata.isDirectory()) {
            return Object.freeze([Object.freeze({ path: prefix })])
          }
        } catch (cause) {
          if (hasErrorCode(cause, "ENOENT")) {
            return Object.freeze([])
          }

          throw cause
        }

        const entries: { readonly path: string }[] = []
        await collectStorageEntries(root, start, entries)
        entries.push(Object.freeze({ path: prefix.replace(/\/$/, "") }))
        return Object.freeze(entries)
      },
      read: async objectPath => {
        assertHealthy()
        const object = resolveStoragePath(root, objectPath)

        try {
          const metadata = await stat(object)

          if (!metadata.isFile()) {
            return undefined
          }
        } catch (cause) {
          if (hasErrorCode(cause, "ENOENT")) {
            return undefined
          }

          throw cause
        }

        return Object.freeze({
          body: createReadStream(object),
          version: Object.freeze({ value: await hashFile(object) }),
        }) satisfies WorkspaceStorageObject
      },
      release: () => {
        release ??= (async () => {
          if (releaseLock !== undefined) {
            await releaseLock()
          }

          assertHealthy()
        })()
        return release
      },
      write: async (objectPath, body, options) => {
        const write = async () => {
          assertHealthy()
          const destination = resolveStoragePath(root, objectPath)
          await verifyWriteCondition(destination, options)
          await mkdir(path.dirname(destination), { recursive: true })
          const temporary = `${destination}.${randomUUID()}.tmp`

          try {
            await pipeline(toReadable(body), createWriteStream(temporary, { flags: "wx" }))
            await rename(temporary, destination)
          } finally {
            await rm(temporary, { force: true })
          }

          return Object.freeze({ value: await hashFile(destination) })
        }

        if (request.lock || objectPath !== "workspace.json") {
          return await write()
        }

        // Unlocked runs still serialize the index compare-and-swap itself.
        const releaseIndex = await lockfile.lock(root, {
          realpath: false,
          retries: 0,
          stale: LOCK_STALE_MS,
          update: LOCK_UPDATE_MS,
        })

        try {
          return await write()
        } finally {
          await releaseIndex()
        }
      },
    }

    if (request.signal.aborted) {
      await lease.release()
      throw request.signal.reason
    }

    return Object.freeze(lease)
  }
}

async function verifyWriteCondition(
  destination: string,
  options: WorkspaceStorageWriteOptions | undefined
): Promise<void> {
  if (options?.condition === undefined) {
    return
  }

  let current: string | undefined

  try {
    current = await hashFile(destination)
  } catch (cause) {
    if (!hasErrorCode(cause, "ENOENT")) {
      throw cause
    }
  }

  if (
    (options.condition.kind === "absent" && current !== undefined) ||
    (options.condition.kind === "version" && current !== options.condition.version.value)
  ) {
    throw new Error("Filesystem Workspace conditional write failed")
  }
}

async function collectStorageEntries(
  root: string,
  directory: string,
  entries: { readonly path: string }[]
): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name)
    const relative = path.relative(root, absolute).split(path.sep).join("/")

    if (entry.isDirectory()) {
      await collectStorageEntries(root, absolute, entries)
    }

    entries.push(Object.freeze({ path: relative }))
  }
}

function resolveStoragePath(root: string, objectPath: string): string {
  if (
    objectPath.length === 0 ||
    objectPath.startsWith("/") ||
    objectPath.includes("\\") ||
    objectPath.split("/").some(segment => segment === "." || segment === "..")
  ) {
    throw new TypeError(`Filesystem Workspace storage path "${objectPath}" is invalid`)
  }

  return path.join(root, ...objectPath.split("/"))
}

function toReadable(body: WorkspaceStorageBody): Readable {
  if (typeof body === "string" || body instanceof Uint8Array) {
    return Readable.from([body])
  }

  return Readable.from(body)
}

async function hashFile(file: string): Promise<string> {
  const hash = createHash("sha256")

  for await (const chunk of createReadStream(file)) {
    hash.update(chunk)
  }

  return hash.digest("hex")
}

function hasErrorCode(value: unknown, code: string): boolean {
  return typeof value === "object" && value !== null && Reflect.get(value, "code") === code
}
