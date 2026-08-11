import { copyFile } from "node:fs/promises"
import { URL } from "node:url"

/** Publishes Starlight's generated sitemap under the standard `/sitemap.xml` URL. */
export function sitemapAliasPlugin() {
  return {
    name: "aml-sitemap-alias",
    hooks: {
      // This integration follows Starlight, whose sitemap hook writes `sitemap-0.xml` first.
      async "astro:build:done"({ dir }) {
        await copyFile(new URL("sitemap-0.xml", dir), new URL("sitemap.xml", dir))
      },
    },
  }
}
