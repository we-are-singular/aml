import { createPersistentWorkspaceProvider, type PersistentWorkspaceHandle, type WorkspaceProvider } from "@aml-jsx/sdk"

import { parseS3WorkspaceOptions, type S3WorkspaceOptions } from "./s3-workspace-options.js"
import { S3WorkspaceStorage, type S3WorkspaceStorageHandle } from "./s3-workspace-storage.js"

/**
 * Persistent Workspace handle containing its staging directory, revision
 * metadata, and S3 storage identity.
 */
export type S3WorkspaceHandle = PersistentWorkspaceHandle<S3WorkspaceStorageHandle>

export type { S3WorkspaceOptions } from "./s3-workspace-options.js"
export type { S3WorkspaceStorageHandle } from "./s3-workspace-storage.js"

/**
 * Creates an S3-compatible Workspace backed by shared AML persistence.
 *
 * Factory construction performs no network I/O. Acquisition lazily opens the
 * client and storage namespace, restores the selected revision into a local
 * staging directory, and optionally holds a renewable object-store lock through
 * save and release.
 *
 * @param options Bucket, client configuration, object prefix, format, and limits.
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
