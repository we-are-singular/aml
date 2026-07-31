import { readFileSync } from "node:fs"
import tailwindcss from "@tailwindcss/vite"
import { defineConfig } from "vite"

const base = process.env.SITE_BASE ?? "/"
const siteUrl = (process.env.SITE_URL ?? base).replace(/\/$/, "")
const { version } = JSON.parse(readFileSync(new URL("../../sdk/package.json", import.meta.url), "utf8")) as {
  version: string
}

export default defineConfig({
  base,
  plugins: [
    tailwindcss(),
    {
      name: "site-url",
      transformIndexHtml: html => html.replaceAll("__SITE_URL__", siteUrl).replaceAll("__SDK_VERSION__", version),
    },
  ],
  build: {
    target: "es2022",
  },
})
