import { WorkspaceConflictError } from "../components/workspace/workspace-conflict-error.js"
import type {
  WorkspaceStorageAcquireRequest,
  WorkspaceStorageAdapter,
  WorkspaceStorageBody,
  WorkspaceStorageLease,
  WorkspaceStorageVersion,
  WorkspaceStorageWriteOptions,
} from "../workspace-persistence/workspace-storage-adapter.js"

interface StoredObject {
  readonly body: Uint8Array
  readonly version: WorkspaceStorageVersion
}

export interface WorkspaceStorageOperation {
  readonly kind: "delete" | "list" | "read" | "release" | "write"
  readonly path?: string
  readonly workspaceId: string
}

/**
 * Stateful storage spy for provider authors and persistence tests.
 */
export class InMemoryWorkspaceStorageAdapter implements WorkspaceStorageAdapter {
  readonly #active = new Map<string, symbol>()
  readonly #objects = new Map<string, Map<string, StoredObject>>()
  readonly #operations: WorkspaceStorageOperation[] = []
  #version = 0
  readonly name = "memory-workspace-storage"

  get operations(): readonly Readonly<WorkspaceStorageOperation>[] {
    return this.#operations
  }

  keys(workspaceId: string): readonly string[] {
    return [...(this.#objects.get(workspaceId)?.keys() ?? [])].sort()
  }

  async text(workspaceId: string, objectPath: string): Promise<string | undefined> {
    const object = this.#objects.get(workspaceId)?.get(objectPath)
    return object === undefined ? undefined : Buffer.from(object.body).toString("utf8")
  }

  async acquire(request: WorkspaceStorageAcquireRequest): Promise<WorkspaceStorageLease> {
    request.signal.throwIfAborted()

    if (request.lock && this.#active.has(request.id)) {
      throw new WorkspaceConflictError(request.id)
    }

    const ownership = request.lock ? Symbol(request.id) : undefined

    if (ownership !== undefined) {
      this.#active.set(request.id, ownership)
    }
    const objects = this.#objects.get(request.id) ?? new Map<string, StoredObject>()
    this.#objects.set(request.id, objects)
    let released = false

    return Object.freeze({
      handle: Object.freeze({
        kind: "memory-workspace-storage",
        workspaceId: request.id,
      }),
      delete: async (paths: readonly string[]) => {
        for (const objectPath of paths) {
          this.#operations.push({ kind: "delete", path: objectPath, workspaceId: request.id })
          objects.delete(objectPath)
        }
      },
      list: async (prefix: string) => {
        this.#operations.push({ kind: "list", path: prefix, workspaceId: request.id })
        return [...objects.keys()]
          .filter(objectPath => objectPath.startsWith(prefix))
          .sort()
          .map(objectPath => Object.freeze({ path: objectPath }))
      },
      read: async (objectPath: string) => {
        this.#operations.push({ kind: "read", path: objectPath, workspaceId: request.id })
        const object = objects.get(objectPath)

        if (object === undefined) {
          return undefined
        }

        return Object.freeze({
          body: bytes(object.body),
          version: object.version,
        })
      },
      release: async () => {
        if (released) {
          return
        }

        released = true
        this.#operations.push({ kind: "release", workspaceId: request.id })

        if (ownership !== undefined && this.#active.get(request.id) === ownership) {
          this.#active.delete(request.id)
        }
      },
      write: async (objectPath: string, body: WorkspaceStorageBody, options: WorkspaceStorageWriteOptions = {}) => {
        this.#operations.push({ kind: "write", path: objectPath, workspaceId: request.id })
        const current = objects.get(objectPath)

        if (
          (options.condition?.kind === "absent" && current !== undefined) ||
          (options.condition?.kind === "version" && current?.version.value !== options.condition.version.value)
        ) {
          throw new Error(`Workspace storage condition failed for "${objectPath}"`)
        }

        const version = Object.freeze({ value: `memory-${++this.#version}` })
        objects.set(
          objectPath,
          Object.freeze({
            body: await collectBody(body),
            version,
          })
        )
        return version
      },
    })
  }
}

async function collectBody(body: WorkspaceStorageBody): Promise<Uint8Array> {
  if (typeof body === "string") {
    return Buffer.from(body)
  }

  if (body instanceof Uint8Array) {
    return Buffer.from(body)
  }

  const chunks: Uint8Array[] = []

  for await (const chunk of body) {
    chunks.push(chunk)
  }

  return Buffer.concat(chunks)
}

async function* bytes(value: Uint8Array): AsyncIterable<Uint8Array> {
  yield Buffer.from(value)
}
