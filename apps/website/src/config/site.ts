export const siteMetadata = {
  name: "AML — Agent Markup Language",
  shortName: "AML",
  title: "AML — Build AI Agents with TypeScript and JSX",
  description:
    "AML is a TypeScript framework for building AI agents. Connect agents, give them tools, and pass their results between reusable JSX components.",
  socialDescription:
    "Build AI agents with TypeScript and JSX. Compose coding agents, tools, and prompts as reusable components.",
  locale: "en_US",
  repository: "https://github.com/we-are-singular/aml",
  npm: "https://www.npmjs.com/package/@aml-jsx/sdk",
  image: {
    path: "og.jpg",
    type: "image/jpeg",
    width: 1343,
    height: 682,
    alt: "AML agent workflows authored as markup, alongside a visual agent workflow tree.",
  },
} as const

/** Builds a root-relative URL that respects Astro's configured base path. */
export function withBase(path = ""): string {
  const base = `/${import.meta.env.BASE_URL.replace(/^\/+|\/+$/g, "")}`.replace(/^\/$/, "")
  const normalizedPath = path.replace(/^\/+/, "")
  return `${base}/${normalizedPath}`
}
