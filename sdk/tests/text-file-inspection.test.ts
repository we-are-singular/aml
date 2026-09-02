import { describe, expect, it } from "vitest"

import { inspectTextStream } from "../src/components/include/text-file-inspection.js"

describe("text file inspection", () => {
  it("validates split UTF-8 and counts logical lines without retaining content", async () => {
    const encoded = new TextEncoder().encode("first\né\nthird")
    const chunks = streamChunks([encoded.slice(0, 7), encoded.slice(7, 8), encoded.slice(8)])

    await expect(inspectTextStream(chunks)).resolves.toEqual({ content: null, lines: 3, size: encoded.byteLength })
  })

  it("rejects invalid UTF-8 while streaming metadata", async () => {
    await expect(inspectTextStream(streamChunks([new Uint8Array([0xff])]))).rejects.toThrow(
      "content must be valid UTF-8"
    )
  })

  it("matches empty and trailing-newline line semantics", async () => {
    await expect(inspectTextStream(streamChunks([]))).resolves.toMatchObject({ lines: 0, size: 0 })
    await expect(inspectTextStream(streamChunks([new TextEncoder().encode("one\ntwo\n")]))).resolves.toMatchObject({
      lines: 2,
    })
  })
})

async function* streamChunks(chunks: readonly Uint8Array[]): AsyncIterable<Uint8Array> {
  for (const chunk of chunks) yield chunk
}
