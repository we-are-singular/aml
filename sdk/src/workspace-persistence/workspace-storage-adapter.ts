/** Body accepted by portable Workspace storage writes. */
export type WorkspaceStorageBody = AsyncIterable<Uint8Array> | Uint8Array | string

/** Opaque storage revision token used for conditional publication. */
export interface WorkspaceStorageVersion {
  /** Provider-owned version value; consumers compare it only by exact value. */
  readonly value: string
}

/** One readable durable object and the version observed with it. */
export interface WorkspaceStorageObject {
  /** Async byte stream consumed once by the persistence layer. */
  readonly body: AsyncIterable<Uint8Array>

  /** Version token captured atomically with the object read. */
  readonly version: WorkspaceStorageVersion
}

/** One storage object path returned from a prefix listing. */
export interface WorkspaceStorageEntry {
  /** Normalized relative path within the acquired Workspace namespace. */
  readonly path: string
}

/** Precondition applied atomically to a storage write. */
export type WorkspaceStorageWriteCondition =
  | {
      /** Requires the destination not to exist. */
      readonly kind: "absent"
    }
  | {
      /** Requires the destination to match `version`. */
      readonly kind: "version"

      /** Opaque version previously returned by `read` or `write`. */
      readonly version: WorkspaceStorageVersion
    }

/** Optional metadata and atomicity controls for one storage write. */
export interface WorkspaceStorageWriteOptions {
  /** Write precondition; omission permits an unconditional replacement. */
  readonly condition?: WorkspaceStorageWriteCondition

  /** Known body byte length supplied to transports that require it. */
  readonly contentLength?: number

  /** MIME type stored with the object when supported by the backend. */
  readonly contentType?: string
}

/** Namespace and locking request passed to a Workspace storage adapter. */
export interface WorkspaceStorageAcquireRequest {
  /** Unique identity of the AML evaluation acquiring storage authority. */
  readonly evaluationId: string

  /** Non-empty normalized durable Workspace identity. */
  readonly id: string

  /** Whether the adapter must acquire exclusive writer authority. */
  readonly lock: boolean

  /** Evaluation signal covering acquisition and storage operations. */
  readonly signal: AbortSignal
}

/**
 * Maps a durable Workspace identity to one readable, portable storage segment.
 *
 * Common IDs such as UUIDs, client IDs, and Slack thread IDs remain unchanged.
 * Only characters that could alter a filesystem path or object-key hierarchy
 * are percent-encoded.
 */
export function workspaceStorageSegment(workspaceId: string): string {
  if (workspaceId.length === 0 || workspaceId !== workspaceId.trim()) {
    throw new TypeError("Workspace storage id must be a non-empty normalized string")
  }

  const encoded = encodeURIComponent(workspaceId).replace(
    /[!'()*]/g,
    character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  )

  // URI components preserve dots, but these two names navigate filesystem roots.
  return encoded === "." || encoded === ".." ? encoded.replaceAll(".", "%2E") : encoded
}

/**
 * Exclusive provider-native access to one Workspace storage namespace.
 */
export interface WorkspaceStorageLease<Handle = unknown> {
  /** Opaque provider handle exposed through the persistent Workspace lease. */
  readonly handle: Handle

  /** Deletes the listed normalized object paths; an empty list is a no-op. */
  delete(paths: readonly string[]): Promise<void>

  /** Lists normalized object paths beneath a normalized prefix. */
  list(prefix: string): Promise<readonly WorkspaceStorageEntry[]>

  /** Reads one object or returns `undefined` when it does not exist. */
  read(path: string): Promise<WorkspaceStorageObject | undefined>

  /** Releases writer authority and lease-owned storage resources; repeat-safe. */
  release(): Promise<void>

  /**
   * Writes one complete object and returns its new opaque version.
   *
   * Conditional failure must reject without modifying the destination.
   */
  write(
    path: string,
    body: WorkspaceStorageBody,
    options?: WorkspaceStorageWriteOptions
  ): Promise<WorkspaceStorageVersion>
}

/**
 * Minimal durable transport implemented by S3 and filesystem providers.
 */
export interface WorkspaceStorageAdapter<Handle = unknown> {
  /** Non-empty normalized provider name exposed by WorkspacePersistence. */
  readonly name: string

  /**
   * Acquires one Workspace storage namespace and optional writer authority.
   *
   * A pre-aborted signal starts no work. Healthy competing writers reject with
   * `WorkspaceConflictError`; other storage failures retain their own identity.
   */
  acquire(request: WorkspaceStorageAcquireRequest): Promise<WorkspaceStorageLease<Handle>>
}
