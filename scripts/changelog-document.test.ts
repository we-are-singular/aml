import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { type ChangelogDraft, updateChangelogDocument } from "./changelog-document.js"

const temporaryRoots: string[] = []

afterEach(async () => {
  const { rm } = await import("node:fs/promises")
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe("updateChangelogDocument", () => {
  it("inserts a release once and replaces the same version on retry", async () => {
    const root = await fixtureRoot()
    await updateChangelogDocument(release(root, { summary: "First summary." }))
    await updateChangelogDocument(release(root, { summary: "Corrected summary." }))

    const content = await readFile(changelogPath(root), "utf8")
    expect(content.match(/changelog:sdk:v1\.2\.3:start/g)).toHaveLength(1)
    expect(content).toContain("{/* changelog:sdk:v1.2.3:start */}\n\n## SDK v1.2.3")
    expect(content).toContain("- feat(agent): add a release (abc1234)\n\n{/* changelog:sdk:v1.2.3:end */}")
    expect(content).not.toContain("* feat(agent)")
    expect(content).toContain("Corrected summary.")
    expect(content).not.toContain("First summary.")
  })

  it("rejects documentation links without a real content route", async () => {
    const root = await fixtureRoot()
    await expect(
      updateChangelogDocument(
        release(root, {
          highlights: [
            {
              details: "Explains the change.",
              links: [{ href: "/docs/not-real/", label: "Missing" }],
              title: "A change.",
            },
          ],
        })
      )
    ).rejects.toThrow("does not resolve")
  })

  it("preserves Markdown and inline HTML authored by the model", async () => {
    const root = await fixtureRoot()
    await updateChangelogDocument(
      release(root, { summary: "Use **Markdown** with <code>inline HTML</code> and `{braces}`." })
    )

    const content = await readFile(changelogPath(root), "utf8")
    expect(content).toContain("Use **Markdown** with <code>inline HTML</code> and `{braces}`.")
  })
})

function release(repoRoot: string, overrides: Partial<ChangelogDraft> = {}) {
  return {
    commitList: "* feat(agent): add a release (abc1234)",
    date: "2026-08-10",
    draft: {
      highlights: [
        {
          details: "Explains the change.",
          links: [{ href: "/docs/reference/runtime/", label: "Runtime reference" }],
          title: "A change.",
        },
      ],
      summary: "Release summary.",
      title: "A useful release",
      ...overrides,
    },
    lane: "sdk" as const,
    repoRoot,
    version: "1.2.3",
  }
}

async function fixtureRoot(): Promise<string> {
  const { mkdtemp } = await import("node:fs/promises")
  const root = await mkdtemp(path.join("/tmp", "aml-changelog-"))
  temporaryRoots.push(root)

  await mkdir(path.dirname(changelogPath(root)), { recursive: true })
  await mkdir(path.join(root, "apps/website/src/content/docs/docs/reference"), { recursive: true })
  await writeFile(changelogPath(root), "---\ntitle: SDK changelog\n---\n\n{/* changelog:entries */}\n")
  await writeFile(
    path.join(root, "apps/website/src/content/docs/docs/reference/runtime.mdx"),
    "---\ntitle: Runtime\n---\n"
  )
  return root
}

function changelogPath(root: string): string {
  return path.join(root, "apps/website/src/content/docs/docs/reference/changelog/sdk.mdx")
}
