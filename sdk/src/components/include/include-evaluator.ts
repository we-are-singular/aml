import { randomUUID } from "node:crypto"
import { lstat, readFile } from "node:fs/promises"
import path from "node:path"

import { EvaluationError } from "../../core/evaluation-error.js"
import type { AgentFileStaging } from "../agent/agent-file-staging.js"
import type { ActiveFilesystem } from "../file/active-filesystem.js"
import type { IncludeProps } from "./include.js"

// New work bypasses coalescing at this limit; pending entries are never evicted
// while another Include still awaits them.
const MAX_PENDING_INCLUDE_READS = 64

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
  readonly #cwd: string
  // Evaluation domains are weak keys so no cache state crosses evaluate() calls
  // or extends the lifetime of a completed evaluation.
  readonly #pendingByEvaluation = new WeakMap<object, PendingIncludeReads>()

  /** Captures the application base directory used by local sources. */
  constructor(cwd: string) {
    if (typeof cwd !== "string" || cwd.length === 0) {
      throw new TypeError("cwd must be a non-empty string")
    }

    this.#cwd = path.resolve(cwd)
  }

  /** Resolves one live file into prompt content or a staged read instruction. */
  async evaluate(
    props: Readonly<IncludeProps>,
    filesystem: ActiveFilesystem | undefined,
    staging: AgentFileStaging | undefined,
    signal: AbortSignal,
    evaluation: object
  ): Promise<Readonly<IncludeEvaluationResult>> {
    const captured = captureProps(props)
    const pending = this.#pendingReads(evaluation)

    try {
      return captured.source === "path"
        ? await this.#fromActivePath(captured, filesystem, staging, signal, pending)
        : await this.#fromLocalSource(captured, staging, signal, pending)
    } catch (cause) {
      signal.throwIfAborted()

      if (cause instanceof EvaluationError) {
        throw cause
      }

      throw new EvaluationError(`<Include> could not read "${captured.value}"`, { cause })
    }
  }

  #pendingReads(evaluation: object): PendingIncludeReads {
    const existing = this.#pendingByEvaluation.get(evaluation)

    if (existing !== undefined) {
      return existing
    }

    const created = new PendingIncludeReads(MAX_PENDING_INCLUDE_READS)
    this.#pendingByEvaluation.set(evaluation, created)
    return created
  }

  async #fromActivePath(
    input: CapturedIncludeProps,
    filesystem: ActiveFilesystem | undefined,
    staging: AgentFileStaging | undefined,
    signal: AbortSignal,
    pending: PendingIncludeReads
  ): Promise<Readonly<IncludeEvaluationResult>> {
    if (filesystem === undefined) {
      throw new EvaluationError("<Include path> requires an enclosing <Workspace> or <Sandbox>")
    }

    const resolvedPath = filesystem.resolvePath(input.value, "<Include> path")
    const identity = filesystem.cacheIdentity()
    const metadata = await pending.share(
      identity,
      `stat:${resolvedPath}`,
      async () => await filesystem.stat(resolvedPath, signal)
    )

    if (metadata.kind !== "file") {
      throw new EvaluationError("<Include> path must identify a regular file")
    }

    if (input.maxBytes !== undefined && metadata.size > input.maxBytes) {
      return await this.#oversizedActivePath(
        input,
        filesystem,
        staging,
        resolvedPath,
        input.maxBytes,
        metadata.size,
        signal,
        pending
      )
    }

    const snapshot = await pending.share(identity, contentKey(resolvedPath), async () => {
      const bytes = await filesystem.readFile(resolvedPath, signal)
      return new ContentSnapshot(bytes)
    })

    if (input.maxBytes !== undefined && snapshot.bytes.byteLength > input.maxBytes) {
      return await this.#oversizedActivePath(
        input,
        filesystem,
        staging,
        resolvedPath,
        input.maxBytes,
        snapshot.bytes.byteLength,
        signal,
        pending,
        snapshot
      )
    }

    return result(input, input.value, snapshot.text(), true, snapshot.bytes.byteLength)
  }

  async #oversizedActivePath(
    input: CapturedIncludeProps,
    filesystem: ActiveFilesystem,
    staging: AgentFileStaging | undefined,
    resolvedPath: string,
    maxBytes: number,
    observedSize: number,
    signal: AbortSignal,
    pending: PendingIncludeReads,
    content?: ContentSnapshot
  ): Promise<Readonly<IncludeEvaluationResult>> {
    const readablePath = filesystem.agentReadablePath(resolvedPath)

    if (readablePath !== undefined) {
      return result(input, input.value, readInstruction(readablePath, observedSize, maxBytes), false, observedSize)
    }

    if (staging === undefined) {
      throw new EvaluationError("an oversized <Include path> in a host Workspace requires a containing <Agent>")
    }

    const snapshot =
      content ??
      (await pending.share(
        filesystem.cacheIdentity(),
        contentKey(resolvedPath),
        async () => new ContentSnapshot(await filesystem.readFile(resolvedPath, signal))
      ))

    // The file may change between stat and read; apply the limit to the bytes
    // that will actually be staged or inlined.
    if (snapshot.bytes.byteLength <= maxBytes) {
      return result(input, input.value, snapshot.text(), true, snapshot.bytes.byteLength)
    }

    const stagedFile = await staging.writeFile(includeStagingPath(input.value), snapshot.bytes)
    return result(
      input,
      input.value,
      readInstruction(stagedFile.path, snapshot.bytes.byteLength, maxBytes),
      false,
      snapshot.bytes.byteLength
    )
  }

  async #fromLocalSource(
    input: CapturedIncludeProps,
    staging: AgentFileStaging | undefined,
    signal: AbortSignal,
    pending: PendingIncludeReads
  ): Promise<Readonly<IncludeEvaluationResult>> {
    const sourcePath = path.resolve(this.#cwd, input.value)
    signal.throwIfAborted()
    const metadata = await pending.share(this, `stat:${sourcePath}`, async () => await lstat(sourcePath))

    if (!metadata.isFile()) {
      throw new EvaluationError("<Include> src must identify a regular file")
    }

    const snapshot = await pending.share(
      this,
      contentKey(sourcePath),
      async () => new ContentSnapshot(await readFile(sourcePath, { signal }))
    )
    signal.throwIfAborted()

    if (input.maxBytes !== undefined && snapshot.bytes.byteLength > input.maxBytes) {
      if (staging === undefined) {
        throw new EvaluationError("an oversized <Include src> requires a containing <Agent>")
      }

      const stagedFile = await staging.writeFile(includeStagingPath(sourcePath), snapshot.bytes)
      return result(
        input,
        stagedFile.path,
        readInstruction(stagedFile.path, snapshot.bytes.byteLength, input.maxBytes),
        false,
        snapshot.bytes.byteLength
      )
    }

    return result(input, input.value, snapshot.text(), true, snapshot.bytes.byteLength)
  }
}

/** Coalesces only work that is still pending, so sequential reads stay live. */
class PendingIncludeReads {
  readonly #entries = new Map<object, Map<string, Promise<unknown>>>()
  #size = 0

  constructor(readonly maxEntries: number) {}

  async share<Result>(owner: object, key: string, operation: () => Promise<Result>): Promise<Result> {
    const existing = this.#entries.get(owner)?.get(key) as Promise<Result> | undefined

    if (existing !== undefined) {
      return await existing
    }

    if (this.#size >= this.maxEntries) {
      return await operation()
    }

    let entries = this.#entries.get(owner)

    if (entries === undefined) {
      entries = new Map()
      this.#entries.set(owner, entries)
    }

    const pending = operation()
    entries.set(key, pending)
    this.#size += 1

    try {
      return await pending
    } finally {
      if (entries.get(key) === pending) {
        entries.delete(key)
        this.#size -= 1

        if (entries.size === 0) {
          this.#entries.delete(owner)
        }
      }
    }
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

  if (children !== undefined) {
    throw new EvaluationError("<Include> does not accept children")
  }

  if ((pathValue === undefined) === (sourceValue === undefined)) {
    throw new EvaluationError("<Include> requires exactly one of path or src")
  }

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

  return Object.freeze({
    content: `${heading}${body}`,
    inline,
    path: renderedPath,
    size,
    source: input.source,
  })
}

function readInstruction(path: string, size: number, maxBytes: number): string {
  return `The file is ${size} bytes, exceeding the ${maxBytes}-byte inline limit. Read it at \`${path}\`.`
}

function decode(content: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(content)
  } catch (cause) {
    throw new EvaluationError("<Include> content must be valid UTF-8", { cause })
  }
}

function contentKey(path: string): string {
  return `content:${path}`
}

/** Shares one byte snapshot and decodes it at most once when an inline consumer needs text. */
class ContentSnapshot {
  #text: string | undefined

  constructor(readonly bytes: Uint8Array) {}

  text(): string {
    this.#text ??= decode(this.bytes)
    return this.#text
  }
}

function includeStagingPath(sourcePath: string): string {
  const name = path.basename(sourcePath).replaceAll(/[^A-Za-z0-9._-]/g, "-") || "include.txt"
  return `.aml/includes/${randomUUID()}/${name}`
}
