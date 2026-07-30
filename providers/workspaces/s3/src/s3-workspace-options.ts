import os from "node:os"
import path from "node:path"

import type { S3Client, S3ClientConfig } from "@aws-sdk/client-s3"
import type { WorkspacePersistenceFormat } from "@aml-jsx/sdk"

const DEFAULT_MAX_ARCHIVE_BYTES = 256 * 1024 * 1024
const DEFAULT_MAX_ENTRIES = 100_000
const DEFAULT_MAX_EXTRACTED_BYTES = 1024 * 1024 * 1024
const DEFAULT_PREFIX = "aml/workspaces"

/**
 * S3-compatible archive storage configuration.
 */
export interface S3WorkspaceOptions {
  readonly bucket: string
  readonly client?: S3Client
  readonly config?: S3ClientConfig
  readonly format?: WorkspacePersistenceFormat
  readonly maxArchiveBytes?: number
  readonly maxEntries?: number
  readonly maxExtractedBytes?: number
  readonly prefix?: string
  readonly temporaryDirectory?: string
}

/**
 * Immutable options captured before the provider touches storage or disk.
 */
export interface ParsedS3WorkspaceOptions {
  readonly bucket: string
  readonly client: S3Client | undefined
  readonly config: S3ClientConfig | undefined
  readonly format: WorkspacePersistenceFormat
  readonly maxArchiveBytes: number
  readonly maxEntries: number
  readonly maxExtractedBytes: number
  readonly prefix: string
  readonly temporaryDirectory: string
}

/**
 * Captures S3 authority and resource limits without performing I/O.
 */
export function parseS3WorkspaceOptions(value: S3WorkspaceOptions): Readonly<ParsedS3WorkspaceOptions> {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("S3 Workspace options must be an object")
  }

  const bucket = requireNormalizedString(value.bucket, "S3 Workspace bucket")
  const prefix = requireObjectPrefix(value.prefix ?? DEFAULT_PREFIX)
  const temporaryDirectory = path.resolve(
    requireNormalizedString(value.temporaryDirectory ?? os.tmpdir(), "S3 Workspace temporaryDirectory")
  )
  const client = value.client
  const config = value.config
  const format = value.format ?? "archive"

  if (client !== undefined && config !== undefined) {
    throw new TypeError("S3 Workspace accepts client or config, not both")
  }

  if (
    client !== undefined &&
    (typeof client !== "object" || client === null || typeof Reflect.get(client, "send") !== "function")
  ) {
    throw new TypeError("S3 Workspace client must be an S3Client")
  }

  if (config !== undefined && (typeof config !== "object" || config === null)) {
    throw new TypeError("S3 Workspace config must be an S3ClientConfig object")
  }

  if (format !== "archive" && format !== "folder") {
    throw new TypeError('S3 Workspace format must be "archive" or "folder"')
  }

  return Object.freeze({
    bucket,
    client,
    config: config === undefined ? undefined : { ...config },
    format,
    maxArchiveBytes: requirePositiveInteger(
      value.maxArchiveBytes ?? DEFAULT_MAX_ARCHIVE_BYTES,
      "S3 Workspace maxArchiveBytes"
    ),
    maxEntries: requirePositiveInteger(value.maxEntries ?? DEFAULT_MAX_ENTRIES, "S3 Workspace maxEntries"),
    maxExtractedBytes: requirePositiveInteger(
      value.maxExtractedBytes ?? DEFAULT_MAX_EXTRACTED_BYTES,
      "S3 Workspace maxExtractedBytes"
    ),
    prefix,
    temporaryDirectory,
  })
}

/**
 * Requires one exact prefix without URL-style or filesystem-style ambiguity.
 */
function requireObjectPrefix(value: unknown): string {
  const prefix = requireNormalizedString(value, "S3 Workspace prefix")

  if (prefix.startsWith("/") || prefix.endsWith("/") || prefix.includes("//")) {
    throw new TypeError("S3 Workspace prefix must not start or end with / or contain empty segments")
  }

  if (prefix.split("/").some(segment => segment === "." || segment === "..")) {
    throw new TypeError("S3 Workspace prefix must not contain traversal segments")
  }

  return prefix
}

/**
 * Rejects configuration values that would change through implicit trimming.
 */
function requireNormalizedString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new TypeError(`${label} must be a non-empty normalized string`)
  }

  return value
}

function requirePositiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`)
  }

  return value
}
