import path from "node:path"

import { EvaluationError } from "../../core/evaluation-error.js"
import type { AgentFileStaging } from "../agent/agent-file-staging.js"
import type { ActiveFilesystem } from "../file/active-filesystem.js"
import { IncludeFileCache, type CachedIncludeFile } from "./include-file-cache.js"
import { HostTextFile, inspectTextBytes, inspectTextStream, type TextFileInspection } from "./text-file-inspection.js"
import type { IncludeProps } from "./include.js"

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

/** Owns Include source selection, caching, staging, and prompt shape. */
export class IncludeEvaluator {
  readonly #cache = new IncludeFileCache(MAX_CACHED_INCLUDE_FILES, MAX_CACHED_INCLUDE_CONTENT_BYTES)
  readonly #cwd: string

  /** Captures the application base directory used by local sources. */
  constructor(cwd: string) {
    if (typeof cwd !== "string" || cwd.length === 0) throw new TypeError("cwd must be a non-empty string")
    this.#cwd = path.resolve(cwd)
  }

  /** Resolves one UTF-8 file into inline content or an Agent-readable reference. */
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

    const readablePath = filesystem.agentReadablePath(resolvedPath)
    if (
      input.maxBytes !== undefined &&
      metadata.size > input.maxBytes &&
      readablePath === undefined &&
      staging === undefined
    ) {
      throw new EvaluationError("an oversized <Include> requires a containing <Agent>")
    }

    return await this.#includeFile(
      input,
      {
        cacheKey: revisionKey(filesystem.cacheNamespace(), resolvedPath, metadata.size, metadata.modifiedAtMs),
        inspect: async retainContent =>
          retainContent
            ? inspectTextBytes(await filesystem.readFile(resolvedPath, signal))
            : await inspectTextStream(await filesystem.readFileChunks(resolvedPath, signal)),
        observedSize: metadata.size,
        readablePath,
        stagingSourcePath: input.value,
      },
      staging
    )
  }

  async #fromLocalSource(
    input: CapturedIncludeProps,
    staging: AgentFileStaging | undefined,
    signal: AbortSignal
  ): Promise<Readonly<IncludeEvaluationResult>> {
    const source = new HostTextFile(path.resolve(this.#cwd, input.value))
    const metadata = await source.stat(signal)
    if (input.maxBytes !== undefined && metadata.size > input.maxBytes && staging === undefined) {
      throw new EvaluationError("an oversized <Include> requires a containing <Agent>")
    }

    return await this.#includeFile(
      input,
      {
        cacheKey: revisionKey("src", source.path, metadata.size, metadata.modifiedAtMs),
        inspect: async retainContent => await source.inspect(retainContent, signal),
        observedSize: metadata.size,
        readablePath: undefined,
        stagingSourcePath: source.path,
      },
      staging
    )
  }

  /** Applies the same cache and output decisions to local and active filesystems. */
  async #includeFile(
    input: CapturedIncludeProps,
    fileAccess: Readonly<IncludeFileAccess>,
    staging: AgentFileStaging | undefined
  ): Promise<Readonly<IncludeEvaluationResult>> {
    // A directly readable oversized Sandbox file needs only streamed metadata.
    // Inline and staged files retain their first byte snapshot for immediate use.
    const retainFirstSnapshot =
      fileAccess.readablePath === undefined || input.maxBytes === undefined || fileAccess.observedSize <= input.maxBytes
    let file: Readonly<TextFileInspection> | undefined = this.#cache.get(fileAccess.cacheKey)
    if (file === undefined) {
      file = await fileAccess.inspect(retainFirstSnapshot)
      this.#cache.set(fileAccess.cacheKey, file)
    }
    const maxBytes = input.maxBytes

    if (maxBytes === undefined || file.size <= maxBytes) {
      // A previous request may have needed only metadata. Load the body now and
      // promote the same revision so later inline requests avoid another read.
      if (file.content === null) {
        file = await fileAccess.inspect(true)
        this.#cache.set(fileAccess.cacheKey, file)
      }
      return result(input, input.value, requiredContent(file), true, file.size)
    }

    if (fileAccess.readablePath !== undefined) {
      return result(
        input,
        input.value,
        readInstruction(input.value, fileAccess.readablePath, file, maxBytes),
        false,
        file.size
      )
    }

    if (staging === undefined) {
      // The file may have grown after the initial stat that passed the early guard.
      throw new EvaluationError("an oversized <Include> requires a containing <Agent>")
    }

    // Metadata-only cache hits must reload the bytes because each Agent owns a
    // separate staging area. Reinspection also handles a stat/read size race.
    if (file.bytes === undefined) {
      file = await fileAccess.inspect(true)
      this.#cache.set(fileAccess.cacheKey, file)
    }
    if (file.size <= maxBytes) {
      return result(input, input.value, requiredContent(file), true, file.size)
    }

    const stagedFile = await staging.writeInclude(fileAccess.stagingSourcePath, requiredBytes(file))
    const renderedPath = input.source === "src" ? stagedFile.path : input.value
    return result(input, renderedPath, readInstruction(input.value, stagedFile.path, file, maxBytes), false, file.size)
  }
}

interface IncludeFileAccess {
  readonly cacheKey: string | undefined
  readonly inspect: (retainContent: boolean) => Promise<Readonly<TextFileInspection>>
  readonly observedSize: number
  readonly readablePath: string | undefined
  readonly stagingSourcePath: string
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

function requiredContent(file: Readonly<TextFileInspection>): string {
  if (file.content === null) throw new Error("Inline Include inspection did not retain content")
  return file.content
}

function requiredBytes(file: Readonly<TextFileInspection>): Uint8Array {
  if (file.bytes === undefined) throw new Error("Staged Include inspection did not retain bytes")
  return file.bytes
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`
  return `${Number((bytes / 1024).toFixed(1))} KiB`
}

function revisionKey(
  namespace: string,
  filePath: string,
  size: number,
  modifiedAtMs: number | undefined
): string | undefined {
  return modifiedAtMs === undefined ? undefined : JSON.stringify([namespace, filePath, size, modifiedAtMs])
}
