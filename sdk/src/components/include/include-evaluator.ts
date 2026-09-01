import { randomUUID } from "node:crypto"
import { lstat, readFile } from "node:fs/promises"
import path from "node:path"

import { EvaluationError } from "../../core/evaluation-error.js"
import type { AgentFileStaging } from "../agent/agent-file-staging.js"
import type { ActiveFilesystem } from "../file/active-filesystem.js"
import type { IncludeProps } from "./include.js"

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
    signal: AbortSignal
  ): Promise<Readonly<IncludeEvaluationResult>> {
    const captured = captureProps(props)

    try {
      return captured.source === "path"
        ? await this.#fromActivePath(captured, filesystem, signal)
        : await this.#fromLocalSource(captured, staging, signal)
    } catch (cause) {
      signal.throwIfAborted()

      if (cause instanceof EvaluationError) {
        throw cause
      }

      throw new EvaluationError(`<Include> could not read "${captured.value}"`, { cause })
    }
  }

  async #fromActivePath(
    input: CapturedIncludeProps,
    filesystem: ActiveFilesystem | undefined,
    signal: AbortSignal
  ): Promise<Readonly<IncludeEvaluationResult>> {
    if (filesystem === undefined) {
      throw new EvaluationError("<Include path> requires an enclosing <Workspace> or <Sandbox>")
    }

    const resolvedPath = filesystem.resolvePath(input.value, "<Include> path")
    const metadata = await filesystem.stat(resolvedPath, signal)

    if (metadata.kind !== "file") {
      throw new EvaluationError("<Include> path must identify a regular file")
    }

    if (input.maxBytes !== undefined && metadata.size > input.maxBytes) {
      return result(
        input,
        input.value,
        readInstruction(input.value, metadata.size, input.maxBytes),
        false,
        metadata.size
      )
    }

    const bytes = await filesystem.readFile(resolvedPath, signal)

    if (input.maxBytes !== undefined && bytes.byteLength > input.maxBytes) {
      return result(
        input,
        input.value,
        readInstruction(input.value, bytes.byteLength, input.maxBytes),
        false,
        bytes.byteLength
      )
    }

    return result(input, input.value, decode(bytes), true, bytes.byteLength)
  }

  async #fromLocalSource(
    input: CapturedIncludeProps,
    staging: AgentFileStaging | undefined,
    signal: AbortSignal
  ): Promise<Readonly<IncludeEvaluationResult>> {
    const sourcePath = path.resolve(this.#cwd, input.value)
    signal.throwIfAborted()
    const metadata = await lstat(sourcePath)

    if (!metadata.isFile()) {
      throw new EvaluationError("<Include> src must identify a regular file")
    }

    const bytes = await readFile(sourcePath, { signal })
    signal.throwIfAborted()
    const content = decode(bytes)

    if (input.maxBytes !== undefined && bytes.byteLength > input.maxBytes) {
      if (staging === undefined) {
        throw new EvaluationError("an oversized <Include src> requires a containing <Agent>")
      }

      const stagedPath = await staging.writeFile(includeStagingPath(sourcePath), bytes)
      return result(
        input,
        stagedPath,
        readInstruction(stagedPath, bytes.byteLength, input.maxBytes),
        false,
        bytes.byteLength
      )
    }

    return result(input, input.value, content, true, bytes.byteLength)
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

function includeStagingPath(sourcePath: string): string {
  const name = path.basename(sourcePath).replaceAll(/[^A-Za-z0-9._-]/g, "-") || "include.txt"
  return `.aml/includes/${randomUUID()}/${name}`
}
