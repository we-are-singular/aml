import { fileURLToPath, URL } from "node:url"

const MARKDOWN_ENDPOINT = fileURLToPath(new URL("./endpoint.ts", import.meta.url))

/** Adds the static `/<docs-route>.md` representation for every Starlight entry. */
export function docsMarkdownPlugin() {
  return {
    name: "aml-docs-markdown",
    hooks: {
      "config:setup"({ addIntegration }) {
        // Register after Starlight's catch-all so `.md` requests reach this route in dev as well as static builds.
        addIntegration({
          name: "aml-docs-markdown-route",
          hooks: {
            "astro:config:setup"({ injectRoute }) {
              injectRoute({ pattern: "/[...path].md", entrypoint: MARKDOWN_ENDPOINT })
            },
          },
        })
      },
    },
  }
}
