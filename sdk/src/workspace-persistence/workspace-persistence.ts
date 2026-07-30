import { createReadStream, createWriteStream } from "node:fs"
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"

import { defineWorkspaceProvider } from "../components/workspace/define-workspace-provider.js"
import type {
  WorkspaceAcquireRequest,
  WorkspaceLease,
  WorkspaceLoadRequest,
  WorkspaceProvider,
  WorkspaceSaveRequest,
} from "../components/workspace/workspace-provider.js"
import { createWorkspaceArchive, extractWorkspaceArchive } from "./workspace-archive.js"
import { downloadWorkspaceFolder, uploadWorkspaceFolder } from "./workspace-folder.js"
import {
  parseWorkspaceIndex,
  workspaceRevisionPath,
  type WorkspaceIndex,
  type WorkspacePersistenceFormat,
  type WorkspaceRevision,
} from "./workspace-index.js"
import { createWorkspaceSnapshot } from "./workspace-snapshot.js"
import type {
  WorkspaceStorageAdapter,
  WorkspaceStorageLease,
  WorkspaceStorageObject,
  WorkspaceStorageVersion,
} from "./workspace-storage-adapter.js"

const DEFAULT_MAX_ARCHIVE_BYTES = 256 * 1024 * 1024
const DEFAULT_MAX_ENTRIES = 100_000
const DEFAULT_MAX_EXTRACTED_BYTES = 1024 * 1024 * 1024
const MAX_INDEX_BYTES = 4 * 1024 * 1024

export interface WorkspacePersistenceOptions<StorageHandle = unknown> {
  readonly format?: WorkspacePersistenceFormat
  readonly maxArchiveBytes?: number
  readonly maxEntries?: number
  readonly maxExtractedBytes?: number
  readonly storage: WorkspaceStorageAdapter<StorageHandle>
  readonly temporaryDirectory?: string
}

export interface PersistentWorkspaceHandle<StorageHandle = unknown> {
  readonly format: WorkspacePersistenceFormat
  readonly kind: "persistent-workspace"
  readonly revisionId?: string
  readonly storage: StorageHandle
}

interface ParsedWorkspacePersistenceOptions<StorageHandle> {
  readonly format: WorkspacePersistenceFormat
  readonly maxArchiveBytes: number
  readonly maxEntries: number
  readonly maxExtractedBytes: number
  readonly storage: WorkspaceStorageAdapter<StorageHandle>
  readonly temporaryDirectory: string
}

interface RestoredWorkspace {
  readonly index: Readonly<WorkspaceIndex> | undefined
  readonly indexVersion: WorkspaceStorageVersion | undefined
  readonly revision: Readonly<WorkspaceRevision> | undefined
}

/**
 * Creates a revision-backed Workspace provider over one small storage adapter.
 */
export function createPersistentWorkspaceProvider<StorageHandle = unknown>(
  options: WorkspacePersistenceOptions<StorageHandle>
): Readonly<WorkspaceProvider<PersistentWorkspaceHandle<StorageHandle>>> {
  return defineWorkspaceProvider(new WorkspacePersistence(parseWorkspacePersistenceOptions(options)))
}

/**
 * Owns Workspace metadata, materialization, formats, and retention.
 */
export class WorkspacePersistence<StorageHandle = unknown> implements WorkspaceProvider<
  PersistentWorkspaceHandle<StorageHandle>
> {
  readonly #options: Readonly<ParsedWorkspacePersistenceOptions<StorageHandle>>
  readonly name: string

  constructor(options: WorkspacePersistenceOptions<StorageHandle> | ParsedWorkspacePersistenceOptions<StorageHandle>) {
    this.#options = parseWorkspacePersistenceOptions(options)
    this.name = this.#options.storage.name
  }

  async acquire(request: WorkspaceAcquireRequest): Promise<WorkspaceLease<PersistentWorkspaceHandle<StorageHandle>>> {
    request.signal.throwIfAborted()
    const storage = await this.#options.storage.acquire({
      evaluationId: request.evaluationId,
      id: request.id,
      lock: request.lock !== false,
      signal: request.signal,
    })
    let leaseRoot: string | undefined

    try {
      leaseRoot = await mkdtemp(path.join(this.#options.temporaryDirectory, "aml-workspace-"))
      const directory = path.join(leaseRoot, "workspace")
      await mkdir(directory)
      const restored = await this.#restore(storage, leaseRoot, directory, request.load, request.signal)
      request.signal.throwIfAborted()

      return this.#createLease({
        directory,
        leaseRoot,
        restored,
        storage,
        workspaceId: request.id,
      })
    } catch (cause) {
      const cleanupErrors: unknown[] = []

      if (leaseRoot !== undefined) {
        try {
          await rm(leaseRoot, { force: true, recursive: true })
        } catch (error) {
          cleanupErrors.push(error)
        }
      }

      try {
        await storage.release()
      } catch (error) {
        cleanupErrors.push(error)
      }

      if (cleanupErrors.length > 0) {
        throw new AggregateError([cause, ...cleanupErrors], "Workspace acquisition and cleanup failed")
      }

      throw cause
    }
  }

  async #restore(
    storage: Readonly<WorkspaceStorageLease<StorageHandle>>,
    leaseRoot: string,
    directory: string,
    load: false | WorkspaceLoadRequest | undefined,
    signal: AbortSignal
  ): Promise<Readonly<RestoredWorkspace>> {
    const storedIndex = await storage.read("workspace.json")
    const index =
      storedIndex === undefined
        ? undefined
        : parseWorkspaceIndex(await readStorageText(storedIndex, MAX_INDEX_BYTES, signal))
    const indexVersion = storedIndex?.version

    if (load === false || index === undefined) {
      if (load !== false && load?.revision !== undefined && load.revision !== "current") {
        throw new Error(`Workspace revision "${load.revision}" does not exist`)
      }

      return Object.freeze({
        index,
        indexVersion,
        revision: undefined,
      })
    }

    const revisionId = load?.revision === undefined || load.revision === "current" ? index.current : load.revision
    const revision = index.revisions.find(candidate => candidate.id === revisionId)

    if (revision === undefined) {
      throw new Error(`Workspace revision "${revisionId}" does not exist`)
    }

    const requiresSelection = load !== undefined && (load.include !== undefined || load.exclude.length > 0)
    const restoredDirectory = requiresSelection ? path.join(leaseRoot, "restored") : directory

    if (requiresSelection) {
      await mkdir(restoredDirectory)
    }

    await this.#restoreRevision(storage, revision, leaseRoot, restoredDirectory, signal)

    if (requiresSelection) {
      await createWorkspaceSnapshot(restoredDirectory, directory, {
        exclude: load.exclude,
        gitignore: false,
        ...(load.include === undefined ? {} : { include: load.include }),
        signal,
      })
    }

    return Object.freeze({
      index,
      indexVersion,
      revision,
    })
  }

  async #restoreRevision(
    storage: Readonly<WorkspaceStorageLease<StorageHandle>>,
    revision: Readonly<WorkspaceRevision>,
    leaseRoot: string,
    directory: string,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()

    if (revision.format === "folder") {
      await downloadWorkspaceFolder(storage, revision.path, directory, this.#options)
      signal.throwIfAborted()
      return
    }

    const object = await storage.read(revision.path)

    if (object === undefined) {
      throw new Error(`Workspace archive revision "${revision.id}" does not exist`)
    }

    const archive = path.join(leaseRoot, `${revision.id}.tar.gz`)
    await writeStorageObject(object, archive, this.#options.maxArchiveBytes, signal)
    await extractWorkspaceArchive(archive, directory, this.#options)
    await rm(archive, { force: true })
  }

  #createLease(options: {
    readonly directory: string
    readonly leaseRoot: string
    readonly restored: Readonly<RestoredWorkspace>
    readonly storage: Readonly<WorkspaceStorageLease<StorageHandle>>
    readonly workspaceId: string
  }): Readonly<WorkspaceLease<PersistentWorkspaceHandle<StorageHandle>>> {
    let index = options.restored.index
    let indexVersion = options.restored.indexVersion
    let release: Promise<void> | undefined

    return Object.freeze({
      directory: options.directory,
      handle: Object.freeze({
        format: this.#options.format,
        kind: "persistent-workspace" as const,
        ...(options.restored.revision === undefined ? {} : { revisionId: options.restored.revision.id }),
        storage: options.storage.handle,
      }),
      id: `${this.name}-${randomUUID()}`,
      release: () => {
        release ??= releasePersistentWorkspace(options.leaseRoot, options.storage)
        return release
      },
      save: async (request?: WorkspaceSaveRequest) => {
        const normalized = normalizeSaveRequest(request)
        normalized.signal.throwIfAborted()
        const revisionId = randomUUID()
        const revision: WorkspaceRevision = Object.freeze({
          createdAt: new Date().toISOString(),
          format: this.#options.format,
          id: revisionId,
          path: workspaceRevisionPath(revisionId, this.#options.format),
        })
        const snapshot = path.join(options.leaseRoot, `snapshot-${revisionId}`)
        const entries = await createWorkspaceSnapshot(options.directory, snapshot, {
          exclude: normalized.exclude,
          gitignore: normalized.gitignore,
          ...(normalized.include === undefined ? {} : { include: normalized.include }),
          signal: normalized.signal,
        })
        validateSnapshotLimits(entries, this.#options)
        let uploaded = false

        try {
          await this.#uploadRevision(options.storage, revision, snapshot, entries)
          uploaded = true
          const revisions = Object.freeze(
            [revision, ...(index?.revisions ?? []).filter(candidate => candidate.id !== revision.id)].slice(
              0,
              normalized.retention
            )
          )
          const nextIndex: WorkspaceIndex = Object.freeze({
            current: revision.id,
            revisions,
            version: 1,
          })
          const serializedIndex = JSON.stringify(nextIndex)

          if (Buffer.byteLength(serializedIndex) > MAX_INDEX_BYTES) {
            throw new RangeError(`Workspace index exceeded ${MAX_INDEX_BYTES} bytes`)
          }

          const nextVersion = await options.storage.write("workspace.json", serializedIndex, {
            condition:
              indexVersion === undefined
                ? { kind: "absent" }
                : {
                    kind: "version",
                    version: indexVersion,
                  },
            contentLength: Buffer.byteLength(serializedIndex),
            contentType: "application/json",
          })
          const pruned = (index?.revisions ?? []).filter(
            candidate => !revisions.some(retained => retained.id === candidate.id)
          )

          index = nextIndex
          indexVersion = nextVersion
          await this.#deleteRevisions(options.storage, pruned)
        } catch (cause) {
          if (uploaded && index?.current !== revision.id) {
            try {
              await this.#deleteRevisions(options.storage, [revision])
            } catch (cleanupError) {
              throw new AggregateError([cause, cleanupError], "Workspace save and orphan cleanup failed")
            }
          }

          throw cause
        } finally {
          await rm(snapshot, { force: true, recursive: true })
        }
      },
    })
  }

  async #uploadRevision(
    storage: Readonly<WorkspaceStorageLease<StorageHandle>>,
    revision: Readonly<WorkspaceRevision>,
    snapshot: string,
    entries: Awaited<ReturnType<typeof createWorkspaceSnapshot>>
  ): Promise<void> {
    if (revision.format === "folder") {
      await uploadWorkspaceFolder(storage, revision.path, snapshot, entries)
      return
    }

    const archive = `${snapshot}.tar.gz`

    try {
      await createWorkspaceArchive(snapshot, archive)
      const metadata = await stat(archive)

      if (metadata.size > this.#options.maxArchiveBytes) {
        throw new RangeError(`Workspace archive exceeded ${this.#options.maxArchiveBytes} bytes`)
      }

      await storage.write(revision.path, createReadStream(archive), {
        condition: { kind: "absent" },
        contentLength: metadata.size,
        contentType: "application/gzip",
      })
    } finally {
      await rm(archive, { force: true })
    }
  }

  async #deleteRevisions(
    storage: Readonly<WorkspaceStorageLease<StorageHandle>>,
    revisions: readonly Readonly<WorkspaceRevision>[]
  ): Promise<void> {
    for (const revision of revisions) {
      if (revision.format === "archive") {
        await storage.delete([revision.path])
        continue
      }

      const entries = await storage.list(revision.path)
      await storage.delete(entries.map(entry => entry.path))
    }
  }
}

function parseWorkspacePersistenceOptions<StorageHandle>(
  value: WorkspacePersistenceOptions<StorageHandle> | ParsedWorkspacePersistenceOptions<StorageHandle>
): Readonly<ParsedWorkspacePersistenceOptions<StorageHandle>> {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Workspace persistence options must be an object")
  }

  const format = value.format ?? "archive"

  if (format !== "archive" && format !== "folder") {
    throw new TypeError('Workspace persistence format must be "archive" or "folder"')
  }

  const storage = value.storage

  if (
    typeof storage !== "object" ||
    storage === null ||
    typeof storage.name !== "string" ||
    storage.name.length === 0 ||
    storage.name !== storage.name.trim() ||
    typeof storage.acquire !== "function"
  ) {
    throw new TypeError("Workspace persistence storage must be a valid adapter")
  }

  return Object.freeze({
    format,
    maxArchiveBytes: positiveInteger(value.maxArchiveBytes ?? DEFAULT_MAX_ARCHIVE_BYTES, "maxArchiveBytes"),
    maxEntries: positiveInteger(value.maxEntries ?? DEFAULT_MAX_ENTRIES, "maxEntries"),
    maxExtractedBytes: positiveInteger(value.maxExtractedBytes ?? DEFAULT_MAX_EXTRACTED_BYTES, "maxExtractedBytes"),
    storage,
    temporaryDirectory: path.resolve(value.temporaryDirectory ?? os.tmpdir()),
  })
}

function normalizeSaveRequest(request: WorkspaceSaveRequest | undefined): Readonly<WorkspaceSaveRequest> {
  return (
    request ??
    Object.freeze({
      exclude: Object.freeze([]),
      gitignore: true,
      outcome: "success" as const,
      retention: 1,
      signal: new AbortController().signal,
    })
  )
}

async function readStorageText(
  object: Readonly<WorkspaceStorageObject>,
  maximumBytes: number,
  signal: AbortSignal
): Promise<string> {
  const chunks: Buffer[] = []
  let bytes = 0

  for await (const chunk of object.body) {
    signal.throwIfAborted()
    bytes += chunk.byteLength

    if (bytes > maximumBytes) {
      throw new RangeError(`Workspace index exceeded ${maximumBytes} bytes`)
    }

    chunks.push(Buffer.from(chunk))
  }

  return Buffer.concat(chunks).toString("utf8")
}

async function writeStorageObject(
  object: Readonly<WorkspaceStorageObject>,
  destination: string,
  maximumBytes: number,
  signal: AbortSignal
): Promise<void> {
  let bytes = 0
  const bounded = async function* () {
    for await (const chunk of object.body) {
      signal.throwIfAborted()
      bytes += chunk.byteLength

      if (bytes > maximumBytes) {
        throw new RangeError(`Workspace archive exceeded ${maximumBytes} bytes`)
      }

      yield chunk
    }
  }

  await pipeline(Readable.from(bounded()), createWriteStream(destination, { flags: "wx" }))
}

async function releasePersistentWorkspace(leaseRoot: string, storage: Readonly<WorkspaceStorageLease>): Promise<void> {
  const errors: unknown[] = []

  try {
    await rm(leaseRoot, { force: true, recursive: true })
  } catch (error) {
    errors.push(error)
  }

  try {
    await storage.release()
  } catch (error) {
    errors.push(error)
  }

  if (errors.length === 1) {
    throw errors[0]
  }

  if (errors.length > 1) {
    throw new AggregateError(errors, "Workspace materialization cleanup and storage release failed")
  }
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`Workspace persistence ${label} must be a positive safe integer`)
  }

  return value
}

function validateSnapshotLimits(
  entries: Awaited<ReturnType<typeof createWorkspaceSnapshot>>,
  limits: Pick<ParsedWorkspacePersistenceOptions<unknown>, "format" | "maxEntries" | "maxExtractedBytes">
): void {
  const archiveRootEntry = limits.format === "archive" ? 1 : 0

  if (entries.length + archiveRootEntry > limits.maxEntries) {
    throw new RangeError(`Workspace snapshot exceeded ${limits.maxEntries} entries`)
  }

  const bytes = entries.reduce((total, entry) => total + entry.size, 0)

  if (!Number.isSafeInteger(bytes) || bytes > limits.maxExtractedBytes) {
    throw new RangeError(`Workspace snapshot exceeded ${limits.maxExtractedBytes} bytes`)
  }
}
