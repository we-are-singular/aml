export interface NavigationItem {
  label: string
  href: string
  isBaseRelative?: boolean
}

export const navigationItems: readonly NavigationItem[] = [
  { label: "Why", href: "#why" },
  { label: "How it works", href: "#how" },
  { label: "Integrations", href: "#providers" },
  { label: "Reference", href: "#reference" },
  { label: "Docs", href: "docs/", isBaseRelative: true },
]

export type BenefitIcon = "markup" | "switch" | "sandbox" | "observe"

export interface Benefit {
  title: string
  description: string
  icon: BenefitIcon
  iconClass: string
}

export const benefits: readonly Benefit[] = [
  {
    title: "Reusable components",
    description:
      "Define an agent once, pass it props, and use it in different workflows. Components can return text, JSX, or async results.",
    icon: "markup",
    iconClass: "bg-resolve-soft font-mono text-[15px] font-semibold text-resolve",
  },
  {
    title: "Your choice of agent",
    description: "Use OpenCode, Codex, GitHub Copilot, GLM, or Pi. Choose a provider for each agent in the tree.",
    icon: "switch",
    iconClass: "bg-agent-soft text-agent",
  },
  {
    title: "Execution and storage",
    description:
      "Run commands in a Sandbox and keep files between runs with a Workspace. AML acquires and releases both.",
    icon: "sandbox",
    iconClass: "bg-signal-soft font-mono text-lg text-signal",
  },
  {
    title: "See what happened",
    description:
      "Inspect agent turns, tool calls, timings, and failures through structured traces. Set limits and cancel runs from your application.",
    icon: "observe",
    iconClass: "bg-ok-soft text-ok",
  },
]

export interface FooterLink {
  label: string
  href: string
  isBaseRelative?: boolean
  isExternal?: boolean
}

export const footerGroups: readonly { label: string; links: readonly FooterLink[] }[] = [
  {
    label: "docs",
    links: [
      { label: "Learn", href: "docs/", isBaseRelative: true },
      { label: "Providers", href: "docs/providers/", isBaseRelative: true },
      { label: "Cookbook", href: "docs/cookbook/", isBaseRelative: true },
      { label: "Reference", href: "docs/reference/", isBaseRelative: true },
      { label: "docs.txt", href: "docs/llms.txt", isBaseRelative: true },
    ],
  },
  {
    label: "project",
    links: [
      { label: "GitHub", href: "https://github.com/we-are-singular/aml", isExternal: true },
      { label: "npm", href: "https://www.npmjs.com/package/@aml-jsx/sdk", isExternal: true },
      { label: "llms.txt", href: "llms.txt", isBaseRelative: true },
    ],
  },
]
