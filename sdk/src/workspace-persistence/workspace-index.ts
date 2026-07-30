export type WorkspacePersistenceFormat = "archive" | "folder"

export interface WorkspaceRevision {
  readonly createdAt: string
  readonly format: WorkspacePersistenceFormat
  readonly id: string
  readonly path: string
}

export interface WorkspaceIndex {
  readonly current: string
  readonly revisions: readonly WorkspaceRevision[]
  readonly version: 1
}

/**
 * Parses the one durable Workspace metadata contract without trusting storage.
 */
export function parseWorkspaceIndex(value: string): Readonly<WorkspaceIndex> {
  let parsed: unknown

  try {
    parsed = JSON.parse(value)
  } catch (cause) {
    throw new Error("Workspace index is not valid JSON", { cause })
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Reflect.get(parsed, "version") !== 1 ||
    typeof Reflect.get(parsed, "current") !== "string" ||
    !Array.isArray(Reflect.get(parsed, "revisions"))
  ) {
    throw new Error("Workspace index is invalid")
  }

  const current = Reflect.get(parsed, "current") as string
  const revisions = (Reflect.get(parsed, "revisions") as unknown[]).map(parseWorkspaceRevision)

  if (current.length === 0 || !revisions.some(revision => revision.id === current)) {
    throw new Error("Workspace index current revision is invalid")
  }

  if (new Set(revisions.map(revision => revision.id)).size !== revisions.length) {
    throw new Error("Workspace index contains duplicate revisions")
  }

  return Object.freeze({
    current,
    revisions: Object.freeze(revisions),
    version: 1 as const,
  })
}

/**
 * Confines every stored artifact to the path derived from its revision identity.
 */
function parseWorkspaceRevision(value: unknown): Readonly<WorkspaceRevision> {
  if (typeof value !== "object" || value === null) {
    throw new Error("Workspace index contains an invalid revision")
  }

  const createdAt = Reflect.get(value, "createdAt")
  const format = Reflect.get(value, "format")
  const id = Reflect.get(value, "id")
  const revisionPath = Reflect.get(value, "path")

  if (
    typeof createdAt !== "string" ||
    !isIsoDate(createdAt) ||
    (format !== "archive" && format !== "folder") ||
    typeof id !== "string" ||
    id.length === 0 ||
    id !== id.trim() ||
    typeof revisionPath !== "string" ||
    revisionPath !== workspaceRevisionPath(id, format)
  ) {
    throw new Error("Workspace index contains an invalid revision")
  }

  return Object.freeze({
    createdAt,
    format,
    id,
    path: revisionPath,
  })
}

export function workspaceRevisionPath(id: string, format: WorkspacePersistenceFormat): string {
  return format === "archive" ? `revisions/${id}.tar.gz` : `revisions/${id}/`
}

function isIsoDate(value: string): boolean {
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
}
