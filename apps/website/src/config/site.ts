export const siteMetadata = {
  name: "AML — Agent Markup Language",
  shortName: "AML",
  title: "AML — Build AI Agents with TypeScript and JSX",
  description:
    "AML is a TypeScript framework for building AI agents. Write reusable JSX components to connect agents, give them tools, and pass their results to the next step.",
  locale: "en_US",
  repository: "https://github.com/we-are-singular/aml",
  npm: "https://www.npmjs.com/package/@aml-jsx/sdk",
  image: {
    path: "og-build-agents.png",
    type: "image/png",
    width: 1200,
    height: 630,
    alt: "Build AI agents with JSX. A weekly standup agent tree alongside an Agent component using a Slack MCP tool.",
  },
} as const

/** Builds a root-relative URL that respects Astro's configured base path. */
export function withBase(path = ""): string {
  const base = `/${import.meta.env.BASE_URL.replace(/^\/+|\/+$/g, "")}`.replace(/^\/$/, "")
  const normalizedPath = path.replace(/^\/+/, "")
  return `${base}/${normalizedPath}`
}
