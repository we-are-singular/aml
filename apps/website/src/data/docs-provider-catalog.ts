import type { ProviderVisualName } from "./provider-catalog"

/** Built-in providers shared by the documentation cards and their Markdown/LLM representation. */
export const docsProviderGroups = [
  {
    label: "Agent providers",
    description: "Own model sessions, native capabilities, and the Agent Client Protocol lifecycle.",
    providers: [
      {
        name: "codex",
        title: "Codex",
        factory: "codexAgent()",
        href: "/docs/providers/agents/codex/",
        meta: "ACP · codex-acp",
        bestFor: "Codex coding workflows",
      },
      {
        name: "copilot",
        title: "GitHub Copilot",
        factory: "copilotAgent()",
        href: "/docs/providers/agents/copilot/",
        meta: "ACP · copilot --acp",
        bestFor: "Copilot CLI model access",
      },
      {
        name: "glm",
        title: "GLM",
        factory: "glmAgent()",
        href: "/docs/providers/agents/glm/",
        meta: "ACP · glm-acp-agent",
        bestFor: "Z.ai Coding Plan models",
      },
      {
        name: "opencode",
        title: "OpenCode",
        factory: "opencodeAgent()",
        href: "/docs/providers/agents/opencode/",
        meta: "ACP · opencode",
        bestFor: "Open source model access",
      },
      {
        name: "pi",
        title: "Pi",
        factory: "piAgent()",
        href: "/docs/providers/agents/pi/",
        meta: "ACP · pi-acp + pi",
        bestFor: "Extensible agent harnesses",
      },
    ],
  },
  {
    label: "Sandbox providers",
    description: "Own process execution, filesystem access, and ephemeral environment cleanup.",
    providers: [
      {
        name: "local-sandbox",
        title: "Local",
        factory: "localSandbox()",
        href: "/docs/providers/sandboxes/local/",
        meta: "Host process · no isolation",
        bestFor: "Trusted development",
      },
      {
        name: "docker",
        title: "Docker",
        factory: "dockerSandbox()",
        href: "/docs/providers/sandboxes/docker/",
        meta: "Docker CLI + daemon",
        bestFor: "Disposable container work",
      },
      {
        name: "daytona",
        title: "Daytona",
        factory: "daytonaSandbox()",
        href: "/docs/providers/sandboxes/daytona/",
        meta: "Daytona credentials",
        bestFor: "Remote dev environments",
      },
      {
        name: "modal",
        title: "Modal",
        factory: "modalSandbox()",
        href: "/docs/providers/sandboxes/modal/",
        meta: "Modal credentials",
        bestFor: "Serverless remote work",
      },
    ],
  },
  {
    label: "Workspace providers",
    description: "Own durable files, revision storage, locking, and materialization into a runtime.",
    providers: [
      {
        name: "local-workspace",
        title: "Local",
        factory: "localWorkspace()",
        href: "/docs/providers/workspaces/local/",
        meta: "Existing directory · direct writes",
        bestFor: "Trusted local state",
      },
      {
        name: "filesystem",
        title: "Filesystem",
        factory: "filesystemWorkspace()",
        href: "/docs/providers/workspaces/filesystem/",
        meta: "Archive or folder revisions",
        bestFor: "Local durable history",
      },
      {
        name: "s3",
        title: "S3",
        factory: "s3Workspace()",
        href: "/docs/providers/workspaces/s3/",
        meta: "S3-compatible object storage",
        bestFor: "Shared durable history",
      },
    ],
  },
] as const satisfies readonly {
  label: string
  description: string
  providers: readonly {
    name: ProviderVisualName
    title: string
    factory: string
    href: string
    meta: string
    bestFor: string
  }[]
}[]
