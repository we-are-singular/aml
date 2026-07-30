export type WorkspaceStorageBody = AsyncIterable<Uint8Array> | Uint8Array | string

export interface WorkspaceStorageVersion {
  readonly value: string
}

export interface WorkspaceStorageObject {
  readonly body: AsyncIterable<Uint8Array>
  readonly version: WorkspaceStorageVersion
}

export interface WorkspaceStorageEntry {
  readonly path: string
}

export type WorkspaceStorageWriteCondition =
  | { readonly kind: "absent" }
  | { readonly kind: "version"; readonly version: WorkspaceStorageVersion }

export interface WorkspaceStorageWriteOptions {
  readonly condition?: WorkspaceStorageWriteCondition
  readonly contentLength?: number
  readonly contentType?: string
}

export interface WorkspaceStorageAcquireRequest {
  readonly evaluationId: string
  readonly id: string
  readonly lock: boolean
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
  readonly handle: Handle

  delete(paths: readonly string[]): Promise<void>
  list(prefix: string): Promise<readonly WorkspaceStorageEntry[]>
  read(path: string): Promise<WorkspaceStorageObject | undefined>
  release(): Promise<void>
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
  readonly name: string

  acquire(request: WorkspaceStorageAcquireRequest): Promise<WorkspaceStorageLease<Handle>>
}
