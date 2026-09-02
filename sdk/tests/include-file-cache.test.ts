import { describe, expect, it } from "vitest"

import { IncludeFileCache } from "../src/components/include/include-file-cache.js"

describe("IncludeFileCache", () => {
  it("promotes a metadata-only revision when its content is inspected later", () => {
    const cache = new IncludeFileCache(2, 10)

    cache.set("same-revision", { content: null, lines: 1, size: 5 })
    expect(cache.get("same-revision")).toEqual({ content: null, lines: 1, size: 5 })

    cache.set("same-revision", {
      bytes: new TextEncoder().encode("hello"),
      content: "hello",
      lines: 1,
      size: 5,
    })

    expect(cache.get("same-revision")).toEqual({ content: "hello", lines: 1, size: 5 })
  })

  it("retains only metadata above the content ceiling", () => {
    const cache = new IncludeFileCache(2, 4)

    cache.set("large-revision", {
      bytes: new TextEncoder().encode("hello"),
      content: "hello",
      lines: 1,
      size: 5,
    })

    expect(cache.get("large-revision")).toEqual({ content: null, lines: 1, size: 5 })
  })

  it("evicts the oldest revision without refreshing promoted entries", () => {
    const cache = new IncludeFileCache(2, 10)

    cache.set("first", { content: null, lines: 1, size: 1 })
    cache.set("second", { content: "b", lines: 1, size: 1 })
    cache.set("first", { content: "a", lines: 1, size: 1 })
    cache.set("third", { content: "c", lines: 1, size: 1 })

    expect(cache.get("first")).toBeUndefined()
    expect(cache.get("second")).toEqual({ content: "b", lines: 1, size: 1 })
    expect(cache.get("third")).toEqual({ content: "c", lines: 1, size: 1 })
  })
})
