import { createReadStream, createWriteStream } from "node:fs"
import { chmod, mkdir, stat } from "node:fs/promises"
import path from "node:path"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"

import type { WorkspaceStorageLease } from "./workspace-storage-adapter.js"
import { validateSnapshotPath, type WorkspaceSnapshotEntry } from "./workspace-snapshot.js"

const MANIFEST_NAME = "manifest.json"
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024

interface WorkspaceFolderManifest {
  readonly entries: readonly WorkspaceSnapshotEntry[]
  readonly version: 1
}

export async function uploadWorkspaceFolder(
  storage: Readonly<WorkspaceStorageLease>,
  revisionPath: string,
  directory: string,
  entries: readonly WorkspaceSnapshotEntry[]
): Promise<readonly string[]> {
  const uploaded: string[] = []
  const manifest = JSON.stringify({
    entries,
    version: 1,
  } satisfies WorkspaceFolderManifest)

  if (Buffer.byteLength(manifest) > MAX_MANIFEST_BYTES) {
    throw new RangeError(`Workspace folder manifest exceeded ${MAX_MANIFEST_BYTES} bytes`)
  }

  try {
    for (const entry of entries) {
      if (entry.type !== "file") {
        continue
      }

      const objectPath = `${revisionPath}files/${entry.path}`
      await storage.write(objectPath, createReadStream(path.join(directory, ...entry.path.split("/"))), {
        condition: { kind: "absent" },
        contentLength: entry.size,
      })
      uploaded.push(objectPath)
    }

    const manifestPath = `${revisionPath}${MANIFEST_NAME}`
    await storage.write(manifestPath, manifest, {
      condition: { kind: "absent" },
      contentLength: Buffer.byteLength(manifest),
      contentType: "application/json",
    })
    uploaded.push(manifestPath)
    return Object.freeze(uploaded)
  } catch (cause) {
    try {
      await storage.delete(uploaded)
    } catch (cleanupError) {
      throw new AggregateError([cause, cleanupError], "Workspace folder upload and cleanup failed")
    }

    throw cause
  }
}

export async function downloadWorkspaceFolder(
  storage: Readonly<WorkspaceStorageLease>,
  revisionPath: string,
  directory: string,
  limits: {
    readonly maxEntries: number
    readonly maxExtractedBytes: number
  }
): Promise<void> {
  const manifestObject = await storage.read(`${revisionPath}${MANIFEST_NAME}`)

  if (manifestObject === undefined) {
    throw new Error("Workspace folder revision is missing its manifest")
  }

  const manifest = parseWorkspaceFolderManifest(await readBodyText(manifestObject.body, MAX_MANIFEST_BYTES), limits)

  for (const entry of manifest.entries) {
    const destination = path.join(directory, ...entry.path.split("/"))

    if (entry.type === "directory") {
      await mkdir(destination, { recursive: true, mode: entry.mode })
      await chmod(destination, entry.mode)
      continue
    }

    const object = await storage.read(`${revisionPath}files/${entry.path}`)

    if (object === undefined) {
      throw new Error(`Workspace folder revision is missing "${entry.path}"`)
    }

    await mkdir(path.dirname(destination), { recursive: true })
    await pipeline(Readable.from(object.body), createWriteStream(destination, { flags: "wx", mode: entry.mode }))
    const metadata = await stat(destination)

    if (metadata.size !== entry.size) {
      throw new Error(`Workspace folder entry "${entry.path}" has an unexpected size`)
    }
  }
}

function parseWorkspaceFolderManifest(
  value: string,
  limits: {
    readonly maxEntries: number
    readonly maxExtractedBytes: number
  }
): Readonly<WorkspaceFolderManifest> {
  let parsed: unknown

  try {
    parsed = JSON.parse(value)
  } catch (cause) {
    throw new Error("Workspace folder manifest is not valid JSON", { cause })
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Reflect.get(parsed, "version") !== 1 ||
    !Array.isArray(Reflect.get(parsed, "entries"))
  ) {
    throw new Error("Workspace folder manifest is invalid")
  }

  const rawEntries = Reflect.get(parsed, "entries") as unknown[]

  if (rawEntries.length > limits.maxEntries) {
    throw new RangeError(`Workspace folder exceeded ${limits.maxEntries} entries`)
  }

  let extractedBytes = 0
  const seen = new Set<string>()
  const entries = rawEntries.map(value => {
    if (typeof value !== "object" || value === null) {
      throw new Error("Workspace folder manifest contains an invalid entry")
    }

    const mode = Reflect.get(value, "mode")
    const entryPath = Reflect.get(value, "path")
    const size = Reflect.get(value, "size")
    const type = Reflect.get(value, "type")

    if (
      typeof entryPath !== "string" ||
      (type !== "directory" && type !== "file") ||
      !Number.isSafeInteger(mode) ||
      mode < 0 ||
      mode > 0o777 ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      (type === "directory" && size !== 0)
    ) {
      throw new Error("Workspace folder manifest contains an invalid entry")
    }

    validateSnapshotPath(entryPath)

    if (seen.has(entryPath)) {
      throw new Error(`Workspace folder manifest contains duplicate path "${entryPath}"`)
    }

    seen.add(entryPath)
    extractedBytes += size

    if (!Number.isSafeInteger(extractedBytes) || extractedBytes > limits.maxExtractedBytes) {
      throw new RangeError(`Workspace folder exceeded ${limits.maxExtractedBytes} extracted bytes`)
    }

    return Object.freeze({
      mode,
      path: entryPath,
      size,
      type,
    }) as WorkspaceSnapshotEntry
  })

  return Object.freeze({
    entries: Object.freeze(entries),
    version: 1 as const,
  })
}

async function readBodyText(body: AsyncIterable<Uint8Array>, maximumBytes: number): Promise<string> {
  const chunks: Buffer[] = []
  let bytes = 0

  for await (const chunk of body) {
    bytes += chunk.byteLength

    if (bytes > maximumBytes) {
      throw new RangeError(`Workspace control object exceeded ${maximumBytes} bytes`)
    }

    chunks.push(Buffer.from(chunk))
  }

  return Buffer.concat(chunks).toString("utf8")
}
