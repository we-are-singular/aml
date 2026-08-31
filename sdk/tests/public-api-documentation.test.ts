import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import ts from "@typescript/typescript6"
import { describe, expect, it } from "vitest"

import { PublicApiDocumentationChecker } from "../scripts/check-public-api-docs.js"

describe("PublicApiDocumentationChecker", () => {
  it("rejects undocumented local shapes reached through references and inheritance", async () => {
    const issues = await checkFixture(`
/** Public configuration. */
export interface PublicConfig extends UndocumentedBase {
  /** Nested configuration. */
  nested?: UndocumentedNested
}

interface UndocumentedBase {
  inherited?: number
}

interface UndocumentedNested {
  value?: string
}
`)

    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: expect.stringContaining("(UndocumentedBase) is missing documentation") }),
        expect.objectContaining({ label: expect.stringContaining("(UndocumentedBase).inherited") }),
        expect.objectContaining({ label: expect.stringContaining("(UndocumentedNested) is missing documentation") }),
        expect.objectContaining({ label: expect.stringContaining("(UndocumentedNested).value") }),
      ])
    )
  })

  it("accepts documented local shapes reached through references and inheritance", async () => {
    const issues = await checkFixture(`
/** Shared configuration. */
interface SharedConfig {
  /** Shared value. */
  shared?: number
}

/** Nested configuration. */
interface NestedConfig {
  /** Nested value. */
  value?: string
}

/** Public configuration. */
export interface PublicConfig extends SharedConfig {
  /** Nested configuration. */
  nested?: NestedConfig
}
`)

    expect(issues).toEqual([])
  })
})

async function checkFixture(source: string) {
  const directory = await mkdtemp(join(tmpdir(), "aml-public-api-docs-"))
  const entrypoint = join(directory, "index.ts")

  try {
    await writeFile(entrypoint, source)
    const program = ts.createProgram({
      options: { module: ts.ModuleKind.ESNext, strict: true, target: ts.ScriptTarget.ES2022 },
      rootNames: [entrypoint],
    })

    return new PublicApiDocumentationChecker(program, directory).check([entrypoint])
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
}
