import { access, readFile, writeFile } from "node:fs/promises"
import path from "node:path"

export type ReleaseLane = "cli" | "sdk"

export interface ChangelogLink {
  readonly href: string
  readonly label: string
}

export interface ChangelogHighlight {
  readonly details: string
  readonly links: readonly ChangelogLink[]
  readonly title: string
}

export interface ChangelogDraft {
  readonly highlights: readonly ChangelogHighlight[]
  readonly summary: string
  readonly title: string
}

const ENTRIES_MARKER = "{/* changelog:entries */}"

/** Validates and idempotently inserts one release into its long-form changelog. */
export async function updateChangelogDocument({
  commitList,
  date,
  draft,
  lane,
  repoRoot,
  version,
}: {
  commitList: string
  date: string
  draft: ChangelogDraft
  lane: ReleaseLane
  repoRoot: string
  version: string
}): Promise<string> {
  await validateDraft(repoRoot, draft)

  const outputPath = path.join(repoRoot, "apps/website/src/content/docs/docs/reference/changelog", `${lane}.mdx`)
  const current = await readFile(outputPath, "utf8")
  const entry = renderEntry({ commitList, date, draft, lane, version })
  const updated = replaceEntry(current, entry, lane, version)

  if (updated !== current) {
    await writeFile(outputPath, updated, "utf8")
  }

  return outputPath
}

async function validateDraft(repoRoot: string, draft: ChangelogDraft): Promise<void> {
  for (const [index, highlight] of draft.highlights.entries()) {
    for (const link of highlight.links) {
      await validateDocsLink(repoRoot, link.href)
    }
  }
}

async function validateDocsLink(repoRoot: string, href: string): Promise<void> {
  if (!href.startsWith("/docs/") || href.includes("?") || href.includes("\0")) {
    throw new TypeError(`Changelog link must be a root-relative docs URL: ${href}`)
  }

  const route = href.slice("/docs/".length).split("#", 1)[0]?.replace(/\/$/, "") ?? ""
  const sourceRoot = path.join(repoRoot, "apps/website/src/content/docs/docs")
  const candidates =
    route.length === 0
      ? [path.join(sourceRoot, "index.mdx")]
      : [path.join(sourceRoot, `${route}.mdx`), path.join(sourceRoot, route, "index.mdx")]

  for (const candidate of candidates) {
    try {
      await access(candidate)
      return
    } catch {
      // Try the other Starlight content shape before rejecting the route.
    }
  }

  throw new TypeError(`Changelog link does not resolve to a docs page: ${href}`)
}

function renderEntry({
  commitList,
  date,
  draft,
  lane,
  version,
}: {
  commitList: string
  date: string
  draft: ChangelogDraft
  lane: ReleaseLane
  version: string
}): string {
  const start = entryMarker(lane, version, "start")
  const end = entryMarker(lane, version, "end")
  const highlights = draft.highlights.map(highlight => {
    const links = highlight.links.map(link => `[${link.label}](${link.href})`).join(" · ")
    return `- **${highlight.title}** ${highlight.details}${links.length === 0 ? "" : ` ${links}`}`
  })

  return [
    start,
    "",
    `## ${lane === "sdk" ? "SDK" : "CLI"} v${version} — ${draft.title}`,
    "",
    `Released ${date}.`,
    "",
    draft.summary,
    "",
    "### Highlights",
    "",
    ...highlights,
    "",
    "### Commits",
    "",
    normalizeMdxCommitList(commitList),
    "",
    end,
  ].join("\n")
}

function replaceEntry(current: string, entry: string, lane: ReleaseLane, version: string): string {
  if (!current.includes(ENTRIES_MARKER)) {
    throw new Error(`Changelog document is missing ${ENTRIES_MARKER}`)
  }

  const start = entryMarker(lane, version, "start")
  const end = entryMarker(lane, version, "end")
  const startIndex = current.indexOf(start)

  if (startIndex === -1) {
    return current.replace(ENTRIES_MARKER, `${ENTRIES_MARKER}\n\n${entry}`)
  }

  const endIndex = current.indexOf(end, startIndex)
  if (endIndex === -1) {
    throw new Error(`Changelog entry ${lane} v${version} is missing its end marker`)
  }

  return `${current.slice(0, startIndex)}${entry}${current.slice(endIndex + end.length)}`
}

function entryMarker(lane: ReleaseLane, version: string, edge: "end" | "start"): string {
  return `{/* changelog:${lane}:v${version}:${edge} */}`
}

function normalizeMdxCommitList(value: string): string {
  return value
    .trim()
    .split(/\r?\n/)
    .map(line => line.replace(/^\*\s+/, "- "))
    .join("\n")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("{", "&#123;")
    .replaceAll("}", "&#125;")
}
