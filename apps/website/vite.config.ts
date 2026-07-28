import tailwindcss from "@tailwindcss/vite"
import { defineConfig } from "vite"

const base = process.env.SITE_BASE ?? "/"
const siteUrl = (process.env.SITE_URL ?? base).replace(/\/$/, "")

export default defineConfig({
  base,
  plugins: [
    tailwindcss(),
    {
      name: "site-url",
      transformIndexHtml: html => html.replaceAll("__SITE_URL__", siteUrl),
    },
  ],
  build: {
    target: "es2022",
  },
})
