import type { APIContext, GetStaticPaths } from "astro"
import { getCollection, type CollectionEntry } from "astro:content"
import { renderDocMarkdown } from "../../lib/docs-markdown"

interface Props {
  entry?: CollectionEntry<"docs">
}

export const prerender = true

export const getStaticPaths: GetStaticPaths = async () => {
  const entries = (await getCollection("docs")) as CollectionEntry<"docs">[]

  return entries.map(entry => ({
    params: { path: entry.id },
    props: { entry },
  }))
}

export function GET({ props, site }: APIContext<Props>): Response {
  if (!props.entry) {
    return new Response("Documentation page not found.\n", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    })
  }

  const canonicalSite = site ?? new URL("https://agent-markup-language.com")
  const markdown = renderDocMarkdown(props.entry, canonicalSite)

  return new Response(markdown, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": "inline",
      "X-Content-Type-Options": "nosniff",
    },
  })
}
