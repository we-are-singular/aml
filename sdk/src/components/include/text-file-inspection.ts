import pathModule from "node:path"

import { EvaluationError } from "../../core/evaluation-error.js"
import { HostFilesystem } from "../file/host-filesystem.js"

/** Metadata and optional reusable data from one UTF-8 file revision. */
export interface TextFileInspection {
  /** Complete original bytes when the caller requested a reusable snapshot. */
  readonly bytes?: Uint8Array

  /** Decoded UTF-8 body when retained; metadata-only inspections report `null`. */
  readonly content: string | null

  /** Logical line count, including a non-empty final line without a newline. */
  readonly lines: number

  /** Encoded byte length observed during this inspection. */
  readonly size: number
}

/** Host-owned text source used by `<Include src>` outside Workspace confinement. */
export class HostTextFile {
  readonly #filesystem: HostFilesystem
  readonly #portablePath: string

  constructor(readonly path: string) {
    this.#filesystem = new HostFilesystem(pathModule.dirname(path))
    this.#portablePath = pathModule.basename(path)
  }

  /** Returns the revision metadata used by the Include cache key. */
  async stat(signal: AbortSignal): Promise<Readonly<{ modifiedAtMs?: number; size: number }>> {
    signal.throwIfAborted()
    const metadata = await this.#filesystem.stat(this.#portablePath, { signal })
    if (metadata.kind !== "file") throw new EvaluationError("<Include> src must identify a regular file")
    return metadata.modifiedAtMs === undefined
      ? Object.freeze({ size: metadata.size })
      : Object.freeze({ modifiedAtMs: metadata.modifiedAtMs, size: metadata.size })
  }

  /** Reads the complete source because inline output and Agent staging need its bytes. */
  async inspect(signal: AbortSignal): Promise<Readonly<TextFileInspection>> {
    return inspectTextBytes(await this.#filesystem.readFile(this.#portablePath, { signal }))
  }
}

/** Inspects an already-loaded file when the caller also needs its bytes or text. */
export function inspectTextBytes(bytes: Uint8Array): Readonly<TextFileInspection> {
  const content = decode(bytes)
  return Object.freeze({ bytes, content, lines: countLines(content), size: bytes.byteLength })
}

/**
 * Validates and counts a large file incrementally without retaining its body.
 *
 * The decoder carries split UTF-8 sequences between chunks. Only the previous
 * decoded character is retained because logical line counting depends on
 * whether the final character is a newline.
 */
export async function inspectTextStream(chunks: AsyncIterable<Uint8Array>): Promise<Readonly<TextFileInspection>> {
  const decoder = new TextDecoder("utf-8", { fatal: true })
  let lastCharacter = ""
  let lines = 0
  let sawCharacter = false
  let size = 0

  for await (const chunk of chunks) {
    size += chunk.byteLength
    const text = decodeChunk(decoder, chunk, true)
    lines += countNewlines(text)
    if (text.length > 0) {
      sawCharacter = true
      lastCharacter = text.at(-1) ?? ""
    }
  }

  const finalText = decodeChunk(decoder)
  lines += countNewlines(finalText)
  if (finalText.length > 0) {
    sawCharacter = true
    lastCharacter = finalText.at(-1) ?? ""
  }

  if (sawCharacter && lastCharacter !== "\n") lines += 1
  return Object.freeze({ content: null, lines, size })
}

/** Converts only decoder failures; errors raised while reading chunks retain their cause. */
function decodeChunk(decoder: TextDecoder, chunk?: Uint8Array, stream = false): string {
  try {
    return chunk === undefined ? decoder.decode() : decoder.decode(chunk, { stream })
  } catch (cause) {
    throw new EvaluationError("<Include> content must be valid UTF-8", { cause })
  }
}

function decode(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch (cause) {
    throw new EvaluationError("<Include> content must be valid UTF-8", { cause })
  }
}

function countLines(content: string): number {
  if (content.length === 0) return 0
  return countNewlines(content) + (content.endsWith("\n") ? 0 : 1)
}

function countNewlines(content: string): number {
  let lines = 0
  for (const character of content) if (character === "\n") lines += 1
  return lines
}
