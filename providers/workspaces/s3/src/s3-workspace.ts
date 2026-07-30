import { createPersistentWorkspaceProvider, type PersistentWorkspaceHandle, type WorkspaceProvider } from "@aml-jsx/sdk"

import { parseS3WorkspaceOptions, type S3WorkspaceOptions } from "./s3-workspace-options.js"
import { S3WorkspaceStorage, type S3WorkspaceStorageHandle } from "./s3-workspace-storage.js"

export type S3WorkspaceHandle = PersistentWorkspaceHandle<S3WorkspaceStorageHandle>

export type { S3WorkspaceOptions } from "./s3-workspace-options.js"
export type { S3WorkspaceStorageHandle } from "./s3-workspace-storage.js"

/**
 * Creates an S3-compatible Workspace backed by shared AML persistence.
 */
export function s3Workspace(options: S3WorkspaceOptions): Readonly<WorkspaceProvider<S3WorkspaceHandle>> {
  const parsed = parseS3WorkspaceOptions(options)

  return createPersistentWorkspaceProvider({
    format: parsed.format,
    maxArchiveBytes: parsed.maxArchiveBytes,
    maxEntries: parsed.maxEntries,
    maxExtractedBytes: parsed.maxExtractedBytes,
    storage: new S3WorkspaceStorage(parsed),
    temporaryDirectory: parsed.temporaryDirectory,
  })
}
