export const siteMetadata = {
  name: "AML — Agent Markup Language",
  shortName: "AML",
  title: "AML — Framework for Agent Workflows",
  description:
    "AML is a TypeScript and JSX framework for building complex, provider-agnostic AI agent workflows as composable, executable trees.",
  socialDescription: "Build complex, provider-agnostic AI agent workflows as composable, executable JSX trees.",
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
