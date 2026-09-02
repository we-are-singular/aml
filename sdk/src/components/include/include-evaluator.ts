import { randomUUID } from "node:crypto"
import { lstat, readFile } from "node:fs/promises"
import path from "node:path"

import { EvaluationError } from "../../core/evaluation-error.js"
import type { AgentFileStaging } from "../agent/agent-file-staging.js"
import type { ActiveFilesystem } from "../file/active-filesystem.js"
import type { IncludeProps } from "./include.js"

// Keep the cache deliberately small and retain only metadata for large files.
const MAX_CACHED_INCLUDE_FILES = 64
const MAX_CACHED_INCLUDE_CONTENT_BYTES = 256 * 1024

/** Observable Include result and safe trace metadata. */
export interface IncludeEvaluationResult {
  readonly content: string
  readonly inline: boolean
  readonly path: string
  readonly size: number
  readonly source: "path" | "src"
}

/** Owns Include source selection, byte limits, staging, and Markdown shape. */
export class IncludeEvaluator {
  readonly #cache = new IncludeFileCache(MAX_CACHED_INCLUDE_FILES)
  readonly #cwd: string

  /** Captures the application base directory used by local sources. */
  constructor(cwd: string) {
    if (typeof cwd !== "string" || cwd.length === 0) throw new TypeError("cwd must be a non-empty string")
    this.#cwd = path.resolve(cwd)
  }

  /** Resolves one live UTF-8 file into prompt content or a staged read instruction. */
  async evaluate(
    props: Readonly<IncludeProps>,
    filesystem: ActiveFilesystem | undefined,
    staging: AgentFileStaging | undefined,
    signal: AbortSignal
  ): Promise<Readonly<IncludeEvaluationResult>> {
    const input = captureProps(props)

    try {
      return input.source === "path"
        ? await this.#fromActivePath(input, filesystem, staging, signal)
        : await this.#fromLocalSource(input, staging, signal)
    } catch (cause) {
      signal.throwIfAborted()
      if (cause instanceof EvaluationError) throw cause
      throw new EvaluationError(`<Include> could not read "${input.value}"`, { cause })
    }
  }

  async #fromActivePath(
    input: CapturedIncludeProps,
    filesystem: ActiveFilesystem | undefined,
    staging: AgentFileStaging | undefined,
    signal: AbortSignal
  ): Promise<Readonly<IncludeEvaluationResult>> {
    if (filesystem === undefined)
      throw new EvaluationError("<Include path> requires an enclosing <Workspace> or <Sandbox>")

    const resolvedPath = filesystem.resolvePath(input.value, "<Include> path")
    const metadata = await filesystem.stat(resolvedPath, signal)
    if (metadata.kind !== "file") throw new EvaluationError("<Include> path must identify a regular file")

    const file = await this.#cache.get(
      revisionKey(filesystem.cacheNamespace(), resolvedPath, metadata.size, metadata.modifiedAtMs),
      async () => inspect(await filesystem.readFile(resolvedPath, signal))
    )

    if (input.maxBytes === undefined || file.size <= input.maxBytes) {
      const inlineFile = file.content === null ? inspect(await filesystem.readFile(resolvedPath, signal)) : file
      return result(input, input.value, textFor(inlineFile), true, inlineFile.size)
    }

    const readablePath = filesystem.agentReadablePath(resolvedPath)
    if (readablePath !== undefined) {
      return result(
        input,
        input.value,
        readInstruction(input.value, readablePath, file, input.maxBytes),
        false,
        file.size
      )
    }
    if (staging === undefined) {
      throw new EvaluationError("an oversized <Include path> in a host Workspace requires a containing <Agent>")
    }

    const stagedBytes = await bytesFor(file, () => filesystem.readFile(resolvedPath, signal))
    const stagedSnapshot = file.bytes === undefined && file.content === null ? inspect(stagedBytes) : file
    if (stagedSnapshot.size <= input.maxBytes) {
      return result(input, input.value, textFor(stagedSnapshot), true, stagedSnapshot.size)
    }
    const stagedFile = await staging.writeFile(includeStagingPath(input.value), stagedBytes)
    return result(
      input,
      input.value,
      readInstruction(input.value, stagedFile.path, stagedSnapshot, input.maxBytes),
      false,
      stagedSnapshot.size
    )
  }

  async #fromLocalSource(
    input: CapturedIncludeProps,
    staging: AgentFileStaging | undefined,
    signal: AbortSignal
  ): Promise<Readonly<IncludeEvaluationResult>> {
    const sourcePath = path.resolve(this.#cwd, input.value)
    signal.throwIfAborted()
    const metadata = await lstat(sourcePath)
    if (!metadata.isFile()) throw new EvaluationError("<Include> src must identify a regular file")

    const file = await this.#cache.get(revisionKey("src", sourcePath, metadata.size, metadata.mtimeMs), async () =>
      inspect(await readFile(sourcePath, { signal }))
    )
    signal.throwIfAborted()

    if (input.maxBytes === undefined || file.size <= input.maxBytes) {
      const inlineFile = file.content === null ? inspect(await readFile(sourcePath, { signal })) : file
      return result(input, input.value, textFor(inlineFile), true, inlineFile.size)
    }
    if (staging === undefined) throw new EvaluationError("an oversized <Include src> requires a containing <Agent>")

    const stagedBytes = await bytesFor(file, () => readFile(sourcePath, { signal }))
    const stagedSnapshot = file.bytes === undefined && file.content === null ? inspect(stagedBytes) : file
    if (stagedSnapshot.size <= input.maxBytes) {
      return result(input, input.value, textFor(stagedSnapshot), true, stagedSnapshot.size)
    }
    const stagedFile = await staging.writeFile(includeStagingPath(sourcePath), stagedBytes)
    return result(
      input,
      stagedFile.path,
      readInstruction(input.value, stagedFile.path, stagedSnapshot, input.maxBytes),
      false,
      stagedSnapshot.size
    )
  }
}

interface CachedIncludeFile {
  readonly content: string | null
  readonly lines: number
  readonly size: number
}

interface InspectedIncludeFile extends CachedIncludeFile {
  readonly bytes?: Uint8Array
}

/** Retains file metadata and bounded content, evicting the oldest revision first. */
class IncludeFileCache {
  readonly #entries = new Map<string, Readonly<CachedIncludeFile>>()
  constructor(readonly maxEntries: number) {}

  async get(
    key: string | undefined,
    load: () => Promise<Readonly<InspectedIncludeFile>>
  ): Promise<Readonly<InspectedIncludeFile>> {
    if (key === undefined) return await load()

    const existing = this.#entries.get(key)
    if (existing !== undefined) return existing

    const loaded = await load()

    if (this.#entries.size >= this.maxEntries) {
      this.#entries.delete(this.#entries.keys().next().value as string)
    }

    this.#entries.set(key, Object.freeze({ content: loaded.content, lines: loaded.lines, size: loaded.size }))
    return loaded
  }
}

interface CapturedIncludeProps {
  readonly maxBytes: number | undefined
  readonly source: "path" | "src"
  readonly title: string | false | undefined
  readonly value: string
}

function captureProps(props: Readonly<IncludeProps>): Readonly<CapturedIncludeProps> {
  const children = Reflect.get(props, "children")
  const pathValue = Reflect.get(props, "path")
  const sourceValue = Reflect.get(props, "src")
  const maxBytes = Reflect.get(props, "maxBytes")
  const title = Reflect.get(props, "title")
  if (children !== undefined) throw new EvaluationError("<Include> does not accept children")
  if ((pathValue === undefined) === (sourceValue === undefined))
    throw new EvaluationError("<Include> requires exactly one of path or src")

  const source = pathValue === undefined ? "src" : "path"
  const value = pathValue === undefined ? sourceValue : pathValue
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new EvaluationError(`<Include> ${source} must be a non-empty normalized string`)
  }
  if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)) {
    throw new EvaluationError("<Include> maxBytes must be a positive safe integer")
  }
  if (
    title !== undefined &&
    title !== false &&
    (typeof title !== "string" || title.length === 0 || title !== title.trim())
  ) {
    throw new EvaluationError("<Include> title must be a non-empty normalized string or false")
  }
  return Object.freeze({
    maxBytes: maxBytes as number | undefined,
    source,
    title: title as string | false | undefined,
    value,
  })
}

function result(
  input: CapturedIncludeProps,
  renderedPath: string,
  body: string,
  inline: boolean,
  size: number
): Readonly<IncludeEvaluationResult> {
  const heading = input.title === false ? "" : `## ${input.title ?? `Contents of \`${renderedPath}\``}\n\n`
  return Object.freeze({ content: `${heading}${body}`, inline, path: renderedPath, size, source: input.source })
}

function readInstruction(
  displayPath: string,
  readablePath: string,
  file: Readonly<CachedIncludeFile>,
  maxBytes: number
): string {
  const lineLabel = file.lines === 1 ? "line" : "lines"
  return `File: \`${displayPath}\` (${formatBytes(file.size)}, ${file.lines} ${lineLabel})\n\nThe file exceeds the ${formatBytes(maxBytes)} inline limit. Read it at \`${readablePath}\`.`
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`
  const kilobytes = bytes / 1024
  return `${Number(kilobytes.toFixed(1))} KiB`
}

function inspect(bytes: Uint8Array): Readonly<InspectedIncludeFile> {
  const content = decode(bytes)
  return Object.freeze({
    bytes,
    content: bytes.byteLength <= MAX_CACHED_INCLUDE_CONTENT_BYTES ? content : null,
    lines: countLines(content),
    size: bytes.byteLength,
  })
}

async function bytesFor(file: Readonly<InspectedIncludeFile>, read: () => Promise<Uint8Array>): Promise<Uint8Array> {
  if (file.bytes !== undefined) return file.bytes
  if (file.content !== null) return new TextEncoder().encode(file.content)
  const bytes = await read()
  decode(bytes)
  return bytes
}

function textFor(file: Readonly<InspectedIncludeFile>): string {
  return file.content ?? decode(file.bytes!)
}

function countLines(content: string): number {
  if (content.length === 0) return 0
  let lines = content.endsWith("\n") ? 0 : 1
  for (const character of content) if (character === "\n") lines += 1
  return lines
}

function decode(content: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(content)
  } catch (cause) {
    throw new EvaluationError("<Include> content must be valid UTF-8", { cause })
  }
}

function revisionKey(
  namespace: string,
  filePath: string,
  size: number,
  modifiedAtMs: number | undefined
): string | undefined {
  return modifiedAtMs === undefined ? undefined : JSON.stringify([namespace, filePath, size, modifiedAtMs])
}

function includeStagingPath(sourcePath: string): string {
  const name = path.basename(sourcePath).replaceAll(/[^A-Za-z0-9._-]/g, "-") || "include.txt"
  return `.aml/includes/${randomUUID()}/${name}`
}
