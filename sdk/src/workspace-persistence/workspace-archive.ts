import path from "node:path"

import { create, extract, list, type ReadEntry } from "tar"

export interface WorkspaceArchiveLimits {
  readonly maxEntries: number
  readonly maxExtractedBytes: number
}

/**
 * Creates the only public archive representation: portable tar plus gzip.
 */
export async function createWorkspaceArchive(directory: string, archive: string): Promise<void> {
  await create(
    {
      cwd: directory,
      file: archive,
      gzip: true,
      portable: true,
      strict: true,
    },
    ["."]
  )
}

/**
 * Validates an untrusted revision completely before extracting it.
 */
export async function extractWorkspaceArchive(
  archive: string,
  directory: string,
  limits: Readonly<WorkspaceArchiveLimits>
): Promise<void> {
  let entries = 0
  let extractedBytes = 0
  let validationError: Error | undefined

  await list({
    file: archive,
    maxDecompressionRatio: 100,
    onReadEntry(entry) {
      try {
        validateArchiveEntry(entry)
        entries += 1
        extractedBytes += entry.size

        if (entries > limits.maxEntries) {
          validationError ??= new RangeError(`Workspace archive exceeded ${limits.maxEntries} entries`)
        }

        if (!Number.isSafeInteger(extractedBytes) || extractedBytes > limits.maxExtractedBytes) {
          validationError ??= new RangeError(`Workspace archive exceeded ${limits.maxExtractedBytes} extracted bytes`)
        }
      } catch (error) {
        validationError ??= error instanceof Error ? error : new Error("Workspace archive validation failed")
      } finally {
        entry.resume()
      }
    },
    strict: true,
  })

  if (validationError !== undefined) {
    throw validationError
  }

  await extract({
    cwd: directory,
    file: archive,
    maxDecompressionRatio: 100,
    preserveOwner: false,
    preservePaths: false,
    strict: true,
    unlink: true,
  })
}

function validateArchiveEntry(entry: ReadEntry): void {
  const entryPath = entry.path.replaceAll("\\", "/")

  if (
    entryPath.includes("\0") ||
    path.posix.isAbsolute(entryPath) ||
    /^[A-Za-z]:/.test(entryPath) ||
    entryPath.split("/").includes("..")
  ) {
    throw new Error(`Workspace archive contains unsafe path "${entry.path}"`)
  }

  if (entry.type !== "File" && entry.type !== "Directory") {
    throw new Error(`Workspace archive entry "${entry.path}" has unsupported type "${entry.type}"`)
  }
}
