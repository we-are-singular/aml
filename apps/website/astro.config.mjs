import { defineConfig } from "astro/config"
import starlight from "@astrojs/starlight"
import sitemap from "@astrojs/sitemap"
import tailwindcss from "@tailwindcss/vite"
import { docsMarkdownPlugin } from "./src/plugins/docs-markdown/plugin.mjs"
import remarkBasePath from "./src/plugins/remark-base-path.mjs"

const base = process.env.SITE_BASE ?? "/"
const site = (process.env.SITE_URL ?? "https://agent-markup-language.com").replace(/\/$/, "")

export default defineConfig({
  base,
  site,
  output: "static",
  trailingSlash: "always",
  markdown: {
    remarkPlugins: [[remarkBasePath, { base }]],
  },
  vite: {
    plugins: [tailwindcss()],
  },
  integrations: [
    starlight({
      title: "AML Docs",
      description: "Learn, build, and operate typed agent workflows with Agent Markup Language.",
      favicon: "/favicon.svg",
      social: [{ icon: "github", label: "GitHub", href: "https://github.com/we-are-singular/aml" }],
      customCss: ["./src/styles/starlight.css"],
      components: {
        Head: "./src/components/docs/DocHead.astro",
        Hero: "./src/components/docs/DocHero.astro",
        MobileMenuToggle: "./src/components/docs/MobileMenuToggle.astro",
        PageTitle: "./src/components/docs/DocPageTitle.astro",
        Sidebar: "./src/components/docs/DocsSidebar.astro",
        SiteTitle: "./src/components/docs/DocSiteTitle.astro",
      },
      plugins: [docsMarkdownPlugin()],
      expressiveCode: {
        styleOverrides: {
          borderColor: ["#343630", "#dedfd9"],
          borderRadius: "0.75rem",
          borderWidth: "1px",
          codeBackground: ["#161815", "#f5f6f3"],
          codeFontFamily: "var(--sl-font-mono)",
          codeFontSize: "0.84rem",
          codeLineHeight: "1.7",
          codePaddingBlock: "1rem",
          codePaddingInline: "1rem",
          frames: {
            editorActiveTabBackground: ["#161815", "#f5f6f3"],
            editorTabBarBackground: ["#1d1f1c", "#eef0ec"],
            editorTabBarBorderBottomColor: ["#343630", "#dedfd9"],
            editorTabBarBorderColor: ["#343630", "#dedfd9"],
            frameBoxShadowCssValue: "none",
            terminalTitlebarBackground: ["#1d1f1c", "#eef0ec"],
            terminalTitlebarBorderBottomColor: ["#343630", "#dedfd9"],
          },
          uiFontFamily: "var(--sl-font)",
        },
      },
      editLink: {
        baseUrl: "https://github.com/we-are-singular/aml/edit/main/apps/website",
      },
      lastUpdated: true,
      tableOfContents: { minHeadingLevel: 2, maxHeadingLevel: 3 },
      sidebar: [
        {
          label: "Learn",
          items: [
            {
              label: "Start here",
              items: [
                { label: "Overview", slug: "docs" },
                { label: "Getting started", slug: "docs/getting-started" },
                { label: "CLI (experimental)", slug: "docs/cli" },
                { label: "Agent skill", slug: "docs/agent-skill" },
                { label: "Examples", slug: "docs/examples" },
                { label: "FAQ", slug: "docs/faq" },
              ],
            },
            {
              label: "Understand AML",
              items: [
                { slug: "docs/concepts" },
                { slug: "docs/ast" },
                { slug: "docs/runtime" },
                { slug: "docs/observability" },
                { slug: "docs/errors" },
              ],
            },
            {
              label: "Operate AML",
              collapsed: true,
              items: [
                { label: "Production readiness", slug: "docs/production" },
                { slug: "docs/production/security" },
                { slug: "docs/production/deployment" },
                { slug: "docs/production/operations" },
                { slug: "docs/production/incident-response" },
              ],
            },
            {
              label: "Extend and contribute",
              collapsed: true,
              items: [{ slug: "docs/integrations" }],
            },
          ],
        },
        {
          label: "Providers",
          items: [
            { label: "Provider catalog", slug: "docs/providers" },
            {
              label: "Agent providers",
              items: [
                { label: "Choose an Agent", slug: "docs/providers/agents" },
                { slug: "docs/providers/agents/codex" },
                { slug: "docs/providers/agents/opencode" },
                { slug: "docs/providers/agents/pi" },
              ],
            },
            {
              label: "Sandbox providers",
              items: [
                { label: "Choose a Sandbox", slug: "docs/providers/sandboxes" },
                { slug: "docs/providers/sandboxes/images" },
                { slug: "docs/providers/sandboxes/local" },
                { slug: "docs/providers/sandboxes/docker" },
                { slug: "docs/providers/sandboxes/daytona" },
                { slug: "docs/providers/sandboxes/modal" },
              ],
            },
            {
              label: "Workspace providers",
              items: [
                { label: "Choose a Workspace", slug: "docs/providers/workspaces" },
                { slug: "docs/providers/workspaces/local" },
                { slug: "docs/providers/workspaces/filesystem" },
                { slug: "docs/providers/workspaces/s3" },
              ],
            },
            { label: "Compatibility", slug: "docs/compatibility" },
            {
              label: "Provider engineering",
              collapsed: true,
              items: [{ label: "How providers work", slug: "docs/provider-authoring" }],
            },
          ],
        },
        {
          label: "Cookbook",
          items: [
            { label: "Recipe index", slug: "docs/cookbook" },
            {
              label: "Core workflows",
              items: [
                { slug: "docs/cookbook/testing" },
                { slug: "docs/cookbook/code-review-workflow" },
                { slug: "docs/cookbook/structured-output" },
                { slug: "docs/cookbook/follow-up-editorial-passes" },
              ],
            },
            {
              label: "Capabilities and resources",
              collapsed: true,
              items: [
                { slug: "docs/cookbook/tools" },
                { slug: "docs/cookbook/mcp" },
                { slug: "docs/cookbook/tool-or-mcp" },
                { slug: "docs/cookbook/sandboxes-and-workspaces" },
                { slug: "docs/cookbook/generated-diagnostic" },
              ],
            },
            {
              label: "Production patterns",
              collapsed: true,
              items: [
                { slug: "docs/cookbook/production-job" },
                { slug: "docs/cookbook/codex-docker-s3" },
                { slug: "docs/cookbook/structured-routing" },
              ],
            },
          ],
        },
        {
          label: "Reference",
          items: [
            { label: "Reference overview", slug: "docs/reference" },
            {
              label: "Primitives",
              items: [
                { label: "Primitives overview", slug: "docs/reference/primitives" },
                { label: "<Agent />", slug: "docs/reference/primitives/agent" },
                { label: "<System />", slug: "docs/reference/primitives/system" },
                { label: "<Tool />", slug: "docs/reference/primitives/tool" },
                { label: "<Mcp />", slug: "docs/reference/primitives/mcp" },
                { label: "<Skill />", slug: "docs/reference/primitives/skill" },
                { label: "<FollowUp />", slug: "docs/reference/primitives/follow-up" },
                { label: "<Sandbox />", slug: "docs/reference/primitives/sandbox" },
                { label: "<Script />", slug: "docs/reference/primitives/script" },
                { label: "<Workspace />", slug: "docs/reference/primitives/workspace" },
                { label: "<File />", slug: "docs/reference/primitives/file" },
                { label: "<>…</>", slug: "docs/reference/primitives/fragment" },
              ],
            },
            {
              label: "Runtime and extension APIs",
              items: [
                { slug: "docs/reference/runtime" },
                { slug: "docs/reference/mcp-server" },
                { slug: "docs/reference/testing" },
                { slug: "docs/reference/providers" },
                { slug: "docs/reference/provider-authoring" },
              ],
            },
          ],
        },
      ],
    }),
    sitemap({
      filter: page => !page.endsWith(".md") && !page.endsWith(".txt"),
    }),
  ],
})
