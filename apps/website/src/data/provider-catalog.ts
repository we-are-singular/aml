export type ProviderIcon =
  | { type: "asset"; path: string; rounded?: boolean }
  | { type: "symbol"; name: "terminal" | "folder" | "files" | "volume" | "network" | "sftp" }

export interface Integration {
  label: string
  icon: ProviderIcon
  href?: string
  status?: "roadmap" | "exploring"
  detail?: string
}

export interface IntegrationGroup {
  id: "agent" | "sandbox" | "workspace"
  label: string
  description: string
  toneClass: string
  integrations: readonly Integration[]
}

const asset = (path: string, rounded = false): ProviderIcon => ({ type: "asset", path, rounded })
const symbol = (name: Extract<ProviderIcon, { type: "symbol" }>["name"]): ProviderIcon => ({
  type: "symbol",
  name,
})

/**
 * Canonical provider visuals shared by the marketing site and documentation.
 * The AI brand marks are vendored from `@lobehub/icons-static-svg` so the static
 * build does not depend on a third-party CDN at runtime. The GLM mark is the
 * Z.ai brand icon vendored from the ACP registry's glm-acp-agent entry.
 */
export const providerVisuals = {
  codex: { label: "Codex", icon: asset("providers/codex.svg") },
  copilot: { label: "GitHub Copilot", icon: asset("providers/github-copilot.svg") },
  glm: { label: "GLM", icon: asset("providers/glm.svg") },
  opencode: { label: "OpenCode", icon: asset("providers/opencode.svg") },
  pi: { label: "Pi", icon: asset("providers/pi.svg") },
  "local-sandbox": { label: "Local Sandbox", icon: symbol("terminal") },
  docker: { label: "Docker", icon: asset("providers/docker.svg") },
  daytona: { label: "Daytona", icon: asset("providers/daytona.png", true) },
  modal: { label: "Modal", icon: asset("providers/modal.svg") },
  "local-workspace": { label: "Local Workspace", icon: symbol("folder") },
  filesystem: { label: "Filesystem", icon: symbol("files") },
  s3: { label: "S3", icon: asset("providers/aws.svg") },
} as const satisfies Record<string, { label: string; icon: ProviderIcon }>

export type ProviderVisualName = keyof typeof providerVisuals

export type S3BackendStatus = "verified" | "native" | "compatible"

export interface S3Backend {
  readonly id: string
  readonly label: string
  readonly icon: ProviderIcon
  readonly status: S3BackendStatus
  readonly statusLabel: string
  readonly summary: string
  readonly href: string
}

/**
 * External object stores that can be evaluated against the one generic
 * `s3Workspace()` adapter. Statuses describe AML evidence, not vendor quality.
 */
export const s3Backends = [
  {
    id: "aws-s3",
    label: "Amazon S3",
    icon: providerVisuals.s3.icon,
    status: "native",
    statusLabel: "Native protocol target",
    summary: "The reference S3 API and SDK target for the adapter.",
    href: "https://docs.aws.amazon.com/AmazonS3/latest/API/Welcome.html",
  },
  {
    id: "cloudflare-r2",
    label: "Cloudflare R2",
    icon: asset("providers/cloudflare.svg"),
    status: "verified",
    statusLabel: "Repository smoke evidence",
    summary: "A credentialed R2 Workspace path exists in the repository; this is not continuous certification.",
    href: "https://developers.cloudflare.com/r2/api/s3/api/",
  },
  {
    id: "minio",
    label: "MinIO",
    icon: asset("providers/minio.svg"),
    status: "compatible",
    statusLabel: "S3-compatible",
    summary: "Protocol candidate; AML has not verified a MinIO deployment.",
    href: "https://min.io/product/s3-compatibility",
  },
  {
    id: "backblaze-b2",
    label: "Backblaze B2",
    icon: asset("providers/backblaze.svg"),
    status: "compatible",
    statusLabel: "S3-compatible",
    summary: "Protocol candidate; AML has not verified a B2 deployment.",
    href: "https://www.backblaze.com/apidocs/introduction-to-the-s3-compatible-api",
  },
  {
    id: "digitalocean-spaces",
    label: "DigitalOcean Spaces",
    icon: asset("providers/digitalocean.svg"),
    status: "compatible",
    statusLabel: "S3-compatible",
    summary: "Protocol candidate; verify conditional writes and listing first.",
    href: "https://docs.digitalocean.com/products/spaces/reference/s3-compatibility/",
  },
  {
    id: "wasabi",
    label: "Wasabi",
    icon: asset("providers/wasabi.svg"),
    status: "compatible",
    statusLabel: "S3-compatible",
    summary: "Protocol candidate; AML has not verified a Wasabi deployment.",
    href: "https://docs.wasabi.com/apidocs/wasabi-api",
  },
  {
    id: "vultr-object-storage",
    label: "Vultr Object Storage",
    icon: asset("providers/vultr.svg"),
    status: "compatible",
    statusLabel: "S3-compatible",
    summary: "Protocol candidate; validate the required S3 operation subset.",
    href: "https://docs.vultr.com/products/storage/object-storage/s3-compatibility-matrix",
  },
  {
    id: "scaleway-object-storage",
    label: "Scaleway Object Storage",
    icon: asset("providers/scaleway.svg"),
    status: "compatible",
    statusLabel: "S3-compatible",
    summary: "Protocol candidate; AML has not verified a Scaleway deployment.",
    href: "https://www.scaleway.com/en/docs/object-storage/concepts/",
  },
] as const satisfies readonly S3Backend[]

export const integrationGroups: readonly IntegrationGroup[] = [
  {
    id: "agent",
    label: "agents",
    description: "harnesses & model runtimes",
    toneClass: "text-agent",
    integrations: [
      { label: "OpenCode", icon: providerVisuals.opencode.icon, href: "docs/providers/agents/opencode/" },
      { label: "Codex", icon: providerVisuals.codex.icon, href: "docs/providers/agents/codex/" },
      { label: "GitHub Copilot", icon: providerVisuals.copilot.icon, href: "docs/providers/agents/copilot/" },
      { label: "GLM", icon: providerVisuals.glm.icon, href: "docs/providers/agents/glm/" },
      { label: "Pi", icon: providerVisuals.pi.icon, href: "docs/providers/agents/pi/" },
      { label: "Claude Code", icon: asset("providers/claude-code.svg"), status: "roadmap" },
      { label: "Cursor", icon: asset("providers/cursor.svg"), status: "roadmap" },
      { label: "Hermes Agent", icon: asset("providers/hermes-agent.svg"), status: "roadmap" },
      { label: "Gemini CLI", icon: asset("providers/gemini-cli.svg"), status: "roadmap" },
      { label: "Cline", icon: asset("providers/cline.svg"), status: "roadmap" },
      { label: "Goose", icon: asset("providers/goose.svg"), status: "roadmap" },
      { label: "Amp", icon: asset("providers/amp.svg"), status: "exploring" },
      { label: "Devin", icon: asset("providers/devin.svg"), status: "exploring" },
    ],
  },
  {
    id: "sandbox",
    label: "sandboxes",
    description: "ephemeral execution",
    toneClass: "text-signal",
    integrations: [
      {
        label: "Local process",
        icon: providerVisuals["local-sandbox"].icon,
        href: "docs/providers/sandboxes/local/",
      },
      { label: "Docker", icon: providerVisuals.docker.icon, href: "docs/providers/sandboxes/docker/" },
      { label: "Daytona", icon: providerVisuals.daytona.icon, href: "docs/providers/sandboxes/daytona/" },
      { label: "Modal", icon: providerVisuals.modal.icon, href: "docs/providers/sandboxes/modal/" },
      { label: "Cloudflare", icon: asset("providers/cloudflare.svg"), status: "roadmap" },
      { label: "Fly.io", icon: asset("providers/fly-io.svg"), status: "roadmap" },
      { label: "AgentOS", icon: asset("agentos-logo.svg"), status: "roadmap" },
      { label: "CodeSandbox", icon: asset("providers/codesandbox.svg"), status: "exploring" },
      { label: "Northflank", icon: asset("providers/northflank.svg"), status: "exploring" },
      { label: "Railway", icon: asset("providers/railway.svg"), status: "exploring" },
      { label: "Vercel Sandbox", icon: asset("providers/vercel.svg"), status: "roadmap" },
      { label: "GitHub Codespaces", icon: asset("providers/github.svg"), status: "roadmap" },
      { label: "AWS Fargate", icon: asset("providers/aws.svg"), status: "exploring" },
    ],
  },
  {
    id: "workspace",
    label: "workspaces",
    description: "durable object storage",
    toneClass: "text-ok",
    integrations: [
      {
        label: "Local disk",
        icon: providerVisuals["local-workspace"].icon,
        href: "docs/providers/workspaces/local/",
      },
      { label: "Amazon S3", icon: providerVisuals.s3.icon, href: "docs/providers/workspaces/s3/" },
      {
        label: "Cloudflare R2",
        detail: "S3 compatible",
        icon: asset("providers/cloudflare.svg"),
        href: "docs/providers/workspaces/s3/#s3-compatible-backends",
      },
      {
        label: "Backblaze B2",
        detail: "S3 compatible",
        icon: asset("providers/backblaze.svg"),
        href: "docs/providers/workspaces/s3/#s3-compatible-backends",
      },
      {
        label: "MinIO",
        detail: "S3 compatible",
        icon: asset("providers/minio.svg"),
        href: "docs/providers/workspaces/s3/#s3-compatible-backends",
      },
      {
        label: "DigitalOcean Spaces",
        detail: "S3 compatible",
        icon: asset("providers/digitalocean.svg"),
        href: "docs/providers/workspaces/s3/#s3-compatible-backends",
      },
      {
        label: "Wasabi Object Storage",
        detail: "S3 compatible",
        icon: asset("providers/wasabi.svg"),
        href: "docs/providers/workspaces/s3/#s3-compatible-backends",
      },
      {
        label: "Vultr Object Storage",
        detail: "S3 compatible",
        icon: asset("providers/vultr.svg"),
        href: "docs/providers/workspaces/s3/#s3-compatible-backends",
      },
      {
        label: "Scaleway Object Storage",
        detail: "S3 compatible",
        icon: asset("providers/scaleway.svg"),
        href: "docs/providers/workspaces/s3/#s3-compatible-backends",
      },
      { label: "Volume mounts", icon: symbol("volume"), status: "roadmap" },
      { label: "Network mounts", icon: symbol("network"), status: "roadmap" },
      { label: "SFTP", icon: symbol("sftp"), status: "roadmap" },
      { label: "Google Drive", icon: asset("providers/google-drive.svg"), status: "roadmap" },
    ],
  },
]

export interface AgentOption {
  id: string
  label: string
  fn: string
  construction: string
  icon: ProviderIcon
}

export interface SandboxOption {
  id: string
  label: string
  fn: string
  construction: string
  icon: ProviderIcon
}

export interface WorkspaceOption {
  id: string
  label: string
  fn: string
  construction: string
  props: string
  icon: ProviderIcon
}

export const agentOptions: readonly AgentOption[] = [
  {
    id: "opencode",
    label: "OpenCode",
    fn: "opencodeAgent",
    construction: 'opencodeAgent({ model: "opencode-go/glm-5.1" })',
    icon: providerVisuals.opencode.icon,
  },
  {
    id: "codex",
    label: "Codex",
    fn: "codexAgent",
    construction: 'codexAgent({ model: "gpt-5.3-codex" })',
    icon: providerVisuals.codex.icon,
  },
  {
    id: "copilot",
    label: "GitHub Copilot",
    fn: "copilotAgent",
    construction: 'copilotAgent({ model: "gpt-5-mini" })',
    icon: providerVisuals.copilot.icon,
  },
  {
    id: "glm",
    label: "GLM",
    fn: "glmAgent",
    construction: 'glmAgent({ model: "glm-5.3" })',
    icon: providerVisuals.glm.icon,
  },
  {
    id: "pi",
    label: "Pi",
    fn: "piAgent",
    construction: 'piAgent({ model: "opencode-go/glm-5.1" })',
    icon: providerVisuals.pi.icon,
  },
]

export const sandboxOptions: readonly SandboxOption[] = [
  {
    id: "local",
    label: "Local",
    fn: "localSandbox",
    construction: 'localSandbox({ workspace: "./project" })',
    icon: providerVisuals["local-sandbox"].icon,
  },
  {
    id: "docker",
    label: "Docker",
    fn: "dockerSandbox",
    construction: "dockerSandbox()",
    icon: providerVisuals.docker.icon,
  },
  {
    id: "daytona",
    label: "Daytona",
    fn: "daytonaSandbox",
    construction: 'daytonaSandbox({ workspace: "./project" })',
    icon: providerVisuals.daytona.icon,
  },
  {
    id: "modal",
    label: "Modal",
    fn: "modalSandbox",
    construction: "modalSandbox({ create: { cpu: 2 } })",
    icon: providerVisuals.modal.icon,
  },
]

export const workspaceOptions: readonly WorkspaceOption[] = [
  {
    id: "workspace-local",
    label: "Local folder",
    fn: "localWorkspace",
    construction: 'localWorkspace({ directory: "./project" })',
    props: 'id="local-project" load',
    icon: providerVisuals["local-workspace"].icon,
  },
  {
    id: "workspace-s3",
    label: "S3",
    fn: "s3Workspace",
    construction: 's3Workspace({ bucket: "agent-workspaces" })',
    props: 'id="thread-42" load save={{ include: ["**/*.md"] }}',
    icon: providerVisuals.s3.icon,
  },
]

/** Keeps the homepage's provider picker and its copyable example on one source of truth. */
export function composeProviderExample(agent: AgentOption, sandbox: SandboxOption, workspace: WorkspaceOption): string {
  return `import {
  Agent, AmlRuntime, Sandbox, Workspace,
  ${agent.fn},
  ${sandbox.fn},
  ${workspace.fn},
} from "@aml-jsx/sdk"

const provider = ${agent.construction}
const sandbox = ${sandbox.construction}
const workspace = ${workspace.construction}
const runtime = new AmlRuntime()

await runtime.evaluate(
  <Workspace ${workspace.props} provider={workspace}>
    <Sandbox provider={sandbox}>
      <Agent provider={provider}>Summarize this repository.</Agent>
    </Sandbox>
  </Workspace>,
)`
}
