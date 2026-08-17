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
  // getStaticPaths only emits existing entries and the router rejects unknown params before
  // GET in both dev and static builds, so a missing entry here is an impossible state.
  const entry = props.entry as CollectionEntry<"docs">

  const canonicalSite = site ?? new URL("https://agent-markup-language.com")
  const markdown = renderDocMarkdown(entry, canonicalSite)

  return new Response(markdown, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": "inline",
      "X-Content-Type-Options": "nosniff",
    },
  })
}
