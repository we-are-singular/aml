import { createProcessor } from "@mdx-js/mdx"
import type { CollectionEntry } from "astro:content"
import agentSandboxChangelog from "../../../../images/aml-agent-sandbox/CHANGELOG.md?raw"
import { withBase } from "../config/site"

interface SourceNode {
  readonly attributes?: readonly SourceAttribute[]
  readonly children?: readonly SourceNode[]
  readonly name?: string | null
  readonly position?: {
    readonly end: { readonly offset?: number }
    readonly start: { readonly offset?: number }
  }
  readonly type: string
}

interface SourceAttribute {
  readonly name?: string
  readonly type: string
  readonly value?: null | string | { readonly value?: string }
}

interface Replacement {
  readonly end: number
  readonly start: number
  readonly value: string
}

/** Returns the canonical HTML route for a Starlight collection entry. */
export function docsRouteFor(entry: CollectionEntry<"docs">): string {
  return withBase(entry.id === "docs" ? "docs/" : `${entry.id}/`)
}

/** Maps a documentation HTML path to the adjacent Markdown alternative. */
export function markdownPathForDocsRoute(pathname: string): string {
  const route = pathname.replace(/\/+$/, "")
  return `${route}.md`
}

/** Converts documentation source and MDX presentation components into portable Markdown. */
export function normalizeMdxForMarkdown(source: string, format: "md" | "mdx" = "mdx"): string {
  const tree = createProcessor({ format }).parse(source) as SourceNode
  const replacements = collectTransforms(tree, source).sort((left, right) => right.start - left.start)

  return replacements
    .reduce(
      (markdown, replacement) =>
        markdown.slice(0, replacement.start) + replacement.value + markdown.slice(replacement.end),
      source
    )
    .replace(/^[\t ]+$/gm, "")
    .replace(/^[\t ]+(?=\[[^\n]+\]\([^\n]+\)[\t ]*$)/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

/** Makes local links portable when Markdown is consumed away from its HTML route. */
function absoluteMarkdownLinks(markdown: string, documentUrl: URL, site: URL): string {
  return markdown.replace(/(!?\[[^\n]*?\]\()(<)?([^\s)>]+)(>?)(?=[\s)])/g, (match, prefix, opening, href, closing) => {
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(href)) return match

    const absoluteUrl = href.startsWith("/") ? new URL(withBase(href), site) : new URL(href, documentUrl)

    return `${prefix}${opening ?? ""}${absoluteUrl.href}${closing ?? ""}`
  })
}

/** Finds MDX nodes whose parent is ordinary Markdown so nested replacements stay isolated. */
function collectTransforms(node: SourceNode, source: string): Replacement[] {
  const replacements: Replacement[] = []

  for (const child of node.children ?? []) {
    const range = sourceRange(child)
    if (!range) continue

    if (child.type === "mdxjsEsm") {
      replacements.push({ ...range, value: "" })
      continue
    }

    if (isMdxElement(child)) {
      replacements.push({ ...range, value: renderMdxElement(child, source) })
      continue
    }

    replacements.push(...collectTransforms(child, source))
  }

  return replacements
}

function renderMdxElement(node: SourceNode, source: string): string {
  const name = node.name ?? ""
  const body = renderMdxBody(node, source)
  const title = attribute(node, "title")
  const description = attribute(node, "description")
  const href = attribute(node, "href")

  switch (name) {
    case "Aside": {
      const type = sentenceCase(attribute(node, "type") ?? "note")
      return `\n**${title ? `${type} — ${title}` : type}**\n\n${body}\n`
    }
    case "Badge":
      return `**${attribute(node, "text") ?? ""}**`
    case "Card":
      return `\n**${title ?? "Guide"}**\n\n${body}\n`
    case "CardGrid":
    case "Steps":
    case "Tabs":
    case "div":
    case "section":
      return `\n${body}\n`
    case "TabItem":
      return `\n**${attribute(node, "label") ?? "Option"}**\n\n${body}\n`
    case "LinkCard":
      return `\n- [${title ?? href ?? "Reference"}](${href ?? "#"})${description ? ` — ${description}` : ""}\n`
    case "ProviderHero":
      return providerHeroMarkdown(node)
    case "ExecutionDirections":
      return executionDirectionsMarkdown
    case "ArchitectureMap":
      return architectureMapMarkdown
    case "AcpBoundary":
      return acpBoundaryMarkdown
    case "ProviderCatalog":
      return providerCatalogMarkdown
    case "nav":
      return navigationMarkdown(node, source)
    case "a": {
      const link = `[${body}](${href ?? "#"})`
      return node.type === "mdxJsxFlowElement" ? `\n${link}\n` : link
    }
    case "h3":
      return `\n### ${body}\n`
    case "kbd":
      return `\`${body}\``
    case "p":
      return attribute(node, "class")?.includes("eyebrow") ? `\n**${body}**\n` : `\n${body}\n`
    default:
      return body ? `\n${body}\n` : ""
  }
}

function renderMdxBody(node: SourceNode, source: string): string {
  const range = sourceRange(node)
  if (!range || !node.name) return ""

  const openingEnd = findOpeningTagEnd(source, range.start, range.end)
  const closingStart = source.lastIndexOf(`</${node.name}`, range.end)
  if (openingEnd < 0 || closingStart < openingEnd) return ""

  const inner = source.slice(openingEnd + 1, closingStart)
  const replacements = collectTransforms(node, source)
    .filter(replacement => replacement.start >= openingEnd && replacement.end <= closingStart)
    .sort((left, right) => right.start - left.start)

  const rendered = replacements.reduce((markdown, replacement) => {
    const start = replacement.start - openingEnd - 1
    const end = replacement.end - openingEnd - 1
    return markdown.slice(0, start) + replacement.value + markdown.slice(end)
  }, inner)

  return dedent(rendered)
}

function providerHeroMarkdown(node: SourceNode): string {
  const title = attribute(node, "title") ?? "Provider"
  const factory = attribute(node, "factory")
  const summary = attribute(node, "summary")
  const bestFor = attribute(node, "bestFor")
  const caution = attribute(node, "caution")

  return [
    `\n**${title}${factory ? ` — \`${factory}\`` : ""}**`,
    summary,
    bestFor ? `- **Best for:** ${bestFor}` : undefined,
    caution ? `- **Know before using:** ${caution}` : undefined,
    "",
  ]
    .filter(value => value !== undefined)
    .join("\n\n")
}

function navigationMarkdown(node: SourceNode, source: string): string {
  const links = directMdxDescendants(node)
    .filter(child => child.name === "a")
    .map(child => {
      const href = attribute(child, "href") ?? "#"
      return `- [${renderMdxBody(child, source)}](${href})`
    })

  return links.length > 0 ? `\n**Documentation shortcuts**\n\n${links.join("\n")}\n` : ""
}

function directMdxDescendants(node: SourceNode): SourceNode[] {
  const descendants: SourceNode[] = []

  for (const child of node.children ?? []) {
    if (isMdxElement(child)) descendants.push(child)
    else descendants.push(...directMdxDescendants(child))
  }

  return descendants
}

function sourceRange(node: SourceNode): { end: number; start: number } | undefined {
  const start = node.position?.start.offset
  const end = node.position?.end.offset
  return typeof start === "number" && typeof end === "number" ? { end, start } : undefined
}

function isMdxElement(node: SourceNode): boolean {
  return node.type === "mdxJsxFlowElement" || node.type === "mdxJsxTextElement"
}

function attribute(node: SourceNode, name: string): string | undefined {
  const value = node.attributes?.find(
    candidate => candidate.type === "mdxJsxAttribute" && candidate.name === name
  )?.value
  if (typeof value === "string") return value
  if (value && typeof value === "object" && typeof value.value === "string") return value.value
  return undefined
}

function findOpeningTagEnd(source: string, start: number, end: number): number {
  let quote: '"' | "'" | undefined

  for (let index = start; index < end; index += 1) {
    const character = source[index]
    if (quote) {
      if (character === quote && source[index - 1] !== "\\") quote = undefined
      continue
    }
    if (character === '"' || character === "'") quote = character
    else if (character === ">") return index
  }

  return -1
}

function dedent(value: string): string {
  const lines = value.replace(/^\n+|\n+$/g, "").split("\n")
  const indents = lines.filter(line => line.trim()).map(line => line.match(/^[\t ]*/)![0].length)
  const indentation = indents.length > 0 ? Math.min(...indents) : 0

  return lines
    .map(line => line.slice(Math.min(indentation, line.length)))
    .join("\n")
    .trim()
}

function sentenceCase(value: string): string {
  return value.length > 0 ? value[0]!.toUpperCase() + value.slice(1) : value
}

const executionDirectionsMarkdown = `
**Read an AML tree in two directions**

- **Scope flows down:** Workspace durable files → Sandbox process authority → Agent Tools, MCP, and prompt. Descendants inherit only capabilities declared around them.
- **Results flow up:** specialist results resolve before the coordinator that consumes them; the root result resolves last.
`

const architectureMapMarkdown = `
**Runtime architecture — one authored tree, three explicit boundaries**

1. [Agent](/docs/providers/agents/) — model session, turns, tools, and protocol translation.
2. [Sandbox](/docs/providers/sandboxes/) — commands, filesystem access, process lifetime, and cleanup.
3. [Workspace](/docs/providers/workspaces/) — materialization, durable revisions, locks, and save policy.
`

const acpBoundaryMarkdown = `
**One ACP session boundary**

Application → AML runtime → selected Sandbox and ACP process ⇄ Agent session.

ACP standardizes the session. It does not install the executable, create the Sandbox, provide credentials, or enforce isolation.
`

const providerCatalogMarkdown = `
**Agent providers**

- [Codex](/docs/providers/agents/codex/) — Codex coding workflows through \`codex-acp\`.
- [GitHub Copilot](/docs/providers/agents/copilot/) — Copilot CLI model access through native \`copilot --acp\`.
- [OpenCode](/docs/providers/agents/opencode/) — open-source model access through OpenCode ACP.
- [Pi](/docs/providers/agents/pi/) — extensible Pi harnesses through \`pi-acp\`.

**Sandbox providers**

- [Local](/docs/providers/sandboxes/local/) — trusted host development; no isolation boundary.
- [Docker](/docs/providers/sandboxes/docker/) — disposable container work.
- [Daytona](/docs/providers/sandboxes/daytona/) — remote development environments.
- [Modal](/docs/providers/sandboxes/modal/) — serverless remote execution.

**Workspace providers**

- [Local](/docs/providers/workspaces/local/) — one existing durable directory.
- [Filesystem](/docs/providers/workspaces/filesystem/) — local archive or folder revisions.
- [S3](/docs/providers/workspaces/s3/) — S3-compatible shared durable history.
`

/** Builds the standalone representation served by each documentation .md route. */
export function renderDocMarkdown(entry: CollectionEntry<"docs">, site: URL): string {
  const canonicalUrl = new URL(docsRouteFor(entry), site)
  const description = entry.data.description ? `${entry.data.description}\n\n` : ""
  const format = entry.filePath?.endsWith(".md") ? "md" : "mdx"
  let source = entry.body ?? ""

  // Remark expands this marker for the HTML page. Expand the same source here
  // so the adjacent .md representation keeps the release entries as well.
  if (entry.id === "docs/reference/changelog/docker") {
    const releases = agentSandboxChangelog.replace(/^# Changelog\s*/, "")
    source = source.replace("{/* aml-agent-sandbox-changelog */}", releases)
  }

  const body = absoluteMarkdownLinks(normalizeMdxForMarkdown(source, format), canonicalUrl, site)

  return [
    `# ${entry.data.title}`,
    "",
    description.trimEnd(),
    `Canonical: ${canonicalUrl.href}`,
    `Documentation index: ${new URL(withBase("docs/"), site).href}`,
    `Complete documentation: ${new URL(withBase("docs/llms.txt"), site).href}`,
    "",
    body,
  ]
    .filter((line, index, lines) => line !== "" || lines[index - 1] !== "")
    .join("\n")
    .trim()
    .concat("\n")
}
