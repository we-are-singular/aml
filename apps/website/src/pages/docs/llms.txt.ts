import type { APIContext } from "astro"
import { getCollection, type CollectionEntry } from "astro:content"
import { withBase } from "../../config/site"
import { renderDocMarkdown } from "../../lib/docs-markdown"

export const prerender = true

const sectionOrder = [
  "docs",
  "docs/getting-started",
  "docs/cli",
  "docs/examples",
  "docs/faq",
  "docs/concepts",
  "docs/sandbox-images",
  "docs/ast",
  "docs/runtime",
  "docs/observability",
  "docs/errors",
  "docs/cookbook",
  "docs/providers",
  "docs/production",
  "docs/compatibility",
  "docs/integrations",
  "docs/provider-authoring",
  "docs/reference",
] as const

function sectionRank(id: string): number {
  const exact = sectionOrder.indexOf(id as (typeof sectionOrder)[number])
  if (exact !== -1) return exact * 100

  // Match the deepest known parent, not the generic `docs` prefix.
  for (let index = sectionOrder.length - 1; index >= 0; index -= 1) {
    if (id.startsWith(`${sectionOrder[index]}/`)) return index * 100 + 1
  }

  return Number.MAX_SAFE_INTEGER
}

function renderEntry(entry: CollectionEntry<"docs">, site: URL): string {
  return renderDocMarkdown(entry, site).trim()
}

export async function GET({ site }: APIContext): Promise<Response> {
  const canonicalSite = site ?? new URL("https://agent-markup-language.com")
  const entries = ((await getCollection("docs")) as CollectionEntry<"docs">[]).sort((left, right) => {
    const rank = sectionRank(left.id) - sectionRank(right.id)
    return rank || left.id.localeCompare(right.id)
  })

  const introduction = [
    "# Agent Markup Language — complete documentation",
    "",
    "This file concatenates every published AML documentation page for language models, search tools, and offline reference.",
    `For the shorter project and editorial overview, see ${new URL(withBase("llms.txt"), canonicalSite).href}.`,
    `For the navigable documentation website, see ${new URL(withBase("docs/"), canonicalSite).href}.`,
    `CLI guide: ${new URL(withBase("docs/cli/"), canonicalSite).href}`,
    "Install the CLI beside the SDK with `npm install @aml-jsx/sdk && npm install --save-dev @aml-jsx/cli`.",
    "Run an exported workflow with `npx aml run ./workflow.tsx`; the file is positional and `--entry` selects a named export.",
    "",
    `Pages included: ${entries.length}`,
  ].join("\n")

  const body = [introduction, ...entries.map(entry => renderEntry(entry, canonicalSite))].join("\n\n---\n\n")

  return new Response(`${body}\n`, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  })
}
