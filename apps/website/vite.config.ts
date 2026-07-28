import tailwindcss from "@tailwindcss/vite"
import { defineConfig } from "vite"

/**
 * GitHub Pages serves project sites from `/<repo>/`, so the built asset URLs
 * must be prefixed. SITE_BASE keeps forks and custom domains overrideable.
 */
const base = process.env.SITE_BASE ?? "/aml/"
const siteUrl = (process.env.SITE_URL ?? base).replace(/\/$/, "")

export default defineConfig({
  base,
  plugins: [
    tailwindcss(),
    {
      name: "site-url",
      transformIndexHtml: (html) => html.replaceAll("__SITE_URL__", siteUrl),
    },
  ],
  build: {
    target: "es2022",
  },
})
