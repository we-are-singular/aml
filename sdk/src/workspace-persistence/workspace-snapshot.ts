import { chmod, copyFile, lstat, mkdir } from "node:fs/promises"
import path from "node:path"

import { globby } from "globby"

export interface WorkspaceSelection {
  readonly exclude: readonly string[]
  readonly gitignore: boolean
  readonly include?: readonly string[]
  readonly signal: AbortSignal
}

export interface WorkspaceSnapshotEntry {
  readonly mode: number
  readonly path: string
  readonly size: number
  readonly type: "directory" | "file"
}

/**
 * Materializes one selected immutable view without modifying the active tree.
 */
export async function createWorkspaceSnapshot(
  source: string,
  destination: string,
  selection: Readonly<WorkspaceSelection>
): Promise<readonly WorkspaceSnapshotEntry[]> {
  selection.signal.throwIfAborted()
  await mkdir(destination, { recursive: true })
  const entries = await globby(selection.include ?? ["**/*"], {
    cwd: source,
    dot: true,
    followSymbolicLinks: false,
    gitignore: selection.include === undefined && selection.gitignore,
    ignore: [...selection.exclude],
    markDirectories: false,
    onlyFiles: false,
  })
  const ordered = [...new Set(entries)].sort(comparePaths)
  const snapshot: WorkspaceSnapshotEntry[] = []

  for (const entry of ordered) {
    selection.signal.throwIfAborted()
    validateSnapshotPath(entry)
    const sourcePath = path.join(source, ...entry.split("/"))
    const destinationPath = path.join(destination, ...entry.split("/"))
    const metadata = await lstat(sourcePath)

    if (metadata.isSymbolicLink()) {
      throw new Error(`Workspace selection contains unsupported symbolic link "${entry}"`)
    }

    if (metadata.isDirectory()) {
      await mkdir(destinationPath, { recursive: true, mode: metadata.mode })
      await chmod(destinationPath, metadata.mode)
      snapshot.push(
        Object.freeze({
          mode: metadata.mode & 0o777,
          path: entry,
          size: 0,
          type: "directory" as const,
        })
      )
      continue
    }

    if (!metadata.isFile()) {
      throw new Error(`Workspace selection contains unsupported entry "${entry}"`)
    }

    await mkdir(path.dirname(destinationPath), { recursive: true })
    await copyFile(sourcePath, destinationPath)
    await chmod(destinationPath, metadata.mode)
    snapshot.push(
      Object.freeze({
        mode: metadata.mode & 0o777,
        path: entry,
        size: metadata.size,
        type: "file" as const,
      })
    )
  }

  return Object.freeze(snapshot)
}

function comparePaths(left: string, right: string): number {
  const depth = left.split("/").length - right.split("/").length
  return depth === 0 ? left.localeCompare(right) : depth
}

export function validateSnapshotPath(value: string): void {
  if (
    value.length === 0 ||
    value.includes("\0") ||
    value.includes("\\") ||
    path.posix.isAbsolute(value) ||
    /^[A-Za-z]:/.test(value) ||
    value.split("/").some(segment => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new Error(`Workspace snapshot contains unsafe path "${value}"`)
  }
}
