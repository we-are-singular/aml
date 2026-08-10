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
    title: "Write the workflow as reusable components",
    description:
      "Package agents, prompts, capabilities, and control flow as ordinary async JSX components. Compose them into larger workflows without hiding how data moves.",
    icon: "markup",
    iconClass: "bg-resolve-soft font-mono text-[15px] font-semibold text-resolve",
  },
  {
    title: "Change providers without starting over",
    description:
      "Move between OpenCode, Codex, and Pi — or use a deterministic test provider — without rebuilding the workflow around a new SDK.",
    icon: "switch",
    iconClass: "bg-agent-soft text-agent",
  },
  {
    title: "Give agents a real place to work",
    description:
      "Attach sandboxes and persistent workspaces exactly where they’re needed. AML manages their scope, lifecycle, and cleanup.",
    icon: "sandbox",
    iconClass: "bg-signal-soft font-mono text-lg text-signal",
  },
  {
    title: "See what happened",
    description:
      "Every run emits structured lifecycle and trace events, so you can inspect a workflow today and build better tooling around it tomorrow.",
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
