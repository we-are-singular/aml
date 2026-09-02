import { createReadStream } from "node:fs"
import { lstat, readFile } from "node:fs/promises"

import { EvaluationError } from "../../core/evaluation-error.js"

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
  constructor(readonly path: string) {}

  /** Returns the revision metadata used by the Include cache key. */
  async stat(signal: AbortSignal): Promise<Readonly<{ modifiedAtMs: number; size: number }>> {
    signal.throwIfAborted()
    const metadata = await lstat(this.path)
    if (!metadata.isFile()) throw new EvaluationError("<Include> src must identify a regular file")
    return Object.freeze({ modifiedAtMs: metadata.mtimeMs, size: metadata.size })
  }

  /** Streams metadata-only reads and loads bytes only for inline or staged output. */
  async inspect(retainContent: boolean, signal: AbortSignal): Promise<Readonly<TextFileInspection>> {
    signal.throwIfAborted()

    if (retainContent) {
      return inspectTextBytes(await readFile(this.path, { signal }))
    }

    return await inspectTextStream(createReadStream(this.path, { signal }))
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

  try {
    for await (const chunk of chunks) {
      size += chunk.byteLength
      const text = decoder.decode(chunk, { stream: true })
      lines += countNewlines(text)
      if (text.length > 0) {
        sawCharacter = true
        lastCharacter = text.at(-1) ?? ""
      }
    }

    const finalText = decoder.decode()
    lines += countNewlines(finalText)
    if (finalText.length > 0) {
      sawCharacter = true
      lastCharacter = finalText.at(-1) ?? ""
    }
  } catch (cause) {
    throw new EvaluationError("<Include> content must be valid UTF-8", { cause })
  }

  if (sawCharacter && lastCharacter !== "\n") lines += 1
  return Object.freeze({ content: null, lines, size })
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
