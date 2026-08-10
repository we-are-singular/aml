import type { APIContext } from "astro"
import { withBase } from "../config/site"

export const prerender = true

export function GET({ site }: APIContext): Response {
  const canonicalSite = site ?? new URL("https://agent-markup-language.com")
  const robots = [
    "User-agent: *",
    `Allow: ${withBase()}`,
    "",
    `Sitemap: ${new URL(withBase("sitemap-index.xml"), canonicalSite).href}`,
    "",
  ].join("\n")

  return new Response(robots, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  })
}
