import path from "node:path"

import {
  codexAgent,
  copilotAgent,
  daytonaSandbox,
  glmAgent,
  dockerSandbox,
  localSandbox,
  modalSandbox,
  opencodeAgent,
  piAgent,
  type AgentProvider,
  type SandboxProvider,
} from "../../src/index.js"

/** Loads the repository-local smoke credentials when an untracked .env exists. */
export function loadSmokeEnvironment(): void {
  try {
    process.loadEnvFile(path.resolve(import.meta.dirname, "../../../.env"))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
}

const SMOKE_AGENT_PATH = `/tmp/aml-agents/bin:/opt/aml-agent-sandbox/node_modules/.bin:${process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"}`
const SMOKE_SANDBOX_IMAGE = "docker.io/wearesingular/aml-agent-sandbox:dev"
const ALL_AGENTS_PRESENT =
  "test -f input.txt && command -v codex-acp && command -v codex && command -v copilot && command -v glm-acp-agent && command -v opencode && command -v pi-acp && command -v pi && command -v pi-mcp-adapter"

export interface SmokeAgentInstance {
  readonly provider: AgentProvider
  release?(): Promise<void>
}

interface SmokeAgentRegistration {
  create(): SmokeAgentInstance
  readonly model: string
}

/**
 * Canonical ACP Agent registry. Every Agent automatically participates in
 * every Sandbox registered below.
 */
export const SMOKE_AGENTS = {
  codex: {
    create() {
      const apiKey = requiredOpenAiApiKey("Codex")
      return { provider: codexAgent({ apiKey, env: { PATH: SMOKE_AGENT_PATH } }) }
    },
    get model() {
      return process.env.AML_CODEX_MODEL ?? "gpt-5.3-codex"
    },
  },
  copilot: {
    create() {
      const githubToken = requiredCopilotGithubToken()
      return {
        provider: copilotAgent({
          env: {
            COPILOT_GITHUB_TOKEN: githubToken,
            PATH: SMOKE_AGENT_PATH,
          },
          model: process.env.AML_COPILOT_MODEL ?? "gpt-5-mini",
        }),
      }
    },
    get model() {
      return process.env.AML_COPILOT_MODEL ?? "gpt-5-mini"
    },
  },
  glm: {
    create() {
      const apiKey = requiredZaiApiKey()
      return { provider: glmAgent({ apiKey, env: { PATH: SMOKE_AGENT_PATH } }) }
    },
    get model() {
      return process.env.AML_GLM_MODEL ?? "glm-5.3"
    },
  },
  opencode: {
    create() {
      const apiKey = requiredOpenAiApiKey("OpenCode")
      return {
        provider: opencodeAgent({
          env: { OPENAI_API_KEY: apiKey, PATH: SMOKE_AGENT_PATH },
          model: process.env.AML_OPENCODE_MODEL ?? "openai/gpt-5.3-codex",
        }),
      }
    },
    get model() {
      return process.env.AML_OPENCODE_MODEL ?? "openai/gpt-5.3-codex"
    },
  },
  pi: {
    create() {
      const apiKey = requiredOpenAiApiKey("Pi")
      return {
        provider: piAgent({
          env: { OPENAI_API_KEY: apiKey, PATH: SMOKE_AGENT_PATH },
          model: process.env.AML_PI_MODEL ?? "openai/gpt-5.3-codex",
        }),
      }
    },
    get model() {
      return process.env.AML_PI_MODEL ?? "openai/gpt-5.3-codex"
    },
  },
} satisfies Record<string, SmokeAgentRegistration>

export type SmokeAgentName = keyof typeof SMOKE_AGENTS

interface SmokeSandboxRegistration {
  create(): SandboxProvider
  readonly environment: string
}

/**
 * Canonical Sandbox registry. Each environment explicitly contains every
 * supported ACP Agent; no selected Agent changes Sandbox construction.
 */
export const SMOKE_SANDBOXES = {
  daytona: {
    create() {
      const apiKey = process.env.DAYTONA_API_KEY
      if (apiKey === undefined) throw new Error("Daytona smoke requires DAYTONA_API_KEY")
      return daytonaSandbox({
        config: { apiKey },
        image: SMOKE_SANDBOX_IMAGE,
      })
    },
    environment: SMOKE_SANDBOX_IMAGE,
  },
  docker: {
    create() {
      return dockerSandbox({
        image: SMOKE_SANDBOX_IMAGE,
        // Match the owner of the bind-mounted local Workspace while keeping
        // the container and its coding Agents unprivileged.
        ...(typeof process.getuid === "function" && typeof process.getgid === "function"
          ? { user: `${process.getuid()}:${process.getgid()}` }
          : {}),
      })
    },
    environment: SMOKE_SANDBOX_IMAGE,
  },
  local: {
    create() {
      return localSandbox({ setup: ALL_AGENTS_PRESENT })
    },
    environment: "host",
  },
  modal: {
    create() {
      const tokenId = process.env.MODAL_API_KEY
      const tokenSecret = process.env.MODAL_API_SECRET
      if (tokenId === undefined || tokenSecret === undefined) {
        throw new Error("Modal smoke requires MODAL_API_KEY and MODAL_API_SECRET")
      }
      return modalSandbox({
        appName: "aml-jsx-smoke",
        config: { tokenId, tokenSecret },
        create: { memoryMiB: 2_048, timeoutMs: 300_000 },
        image: SMOKE_SANDBOX_IMAGE,
      })
    },
    environment: SMOKE_SANDBOX_IMAGE,
  },
} satisfies Record<string, SmokeSandboxRegistration>

export type SmokeSandboxName = keyof typeof SMOKE_SANDBOXES

export const KITCHEN_SINK_WORKSPACE_NAMES = ["local", "r2"] as const
export const KITCHEN_SINK_MCP_NAMES = ["context7", "none"] as const

export type KitchenSinkWorkspaceName = (typeof KITCHEN_SINK_WORKSPACE_NAMES)[number]
export type KitchenSinkMcpName = (typeof KITCHEN_SINK_MCP_NAMES)[number]

export interface KitchenSinkSelection {
  readonly agent: SmokeAgentName
  readonly mcp: KitchenSinkMcpName
  readonly sandbox: SmokeSandboxName
  readonly workspace: KitchenSinkWorkspaceName
}

export type KitchenSinkCommand =
  | { readonly kind: "help" }
  | { readonly kind: "run"; readonly selection: KitchenSinkSelection }

export const DEFAULT_KITCHEN_SINK_SELECTION: KitchenSinkSelection = Object.freeze({
  agent: "opencode",
  mcp: "context7",
  sandbox: "modal",
  workspace: "r2",
})

export const SMOKE_AGENT_NAMES = Object.keys(SMOKE_AGENTS).sort() as SmokeAgentName[]
export const SMOKE_SANDBOX_NAMES = Object.keys(SMOKE_SANDBOXES).sort() as SmokeSandboxName[]

export interface SmokeCase {
  readonly agent: SmokeAgentName
  readonly sandbox: SmokeSandboxName
}

export interface SmokeSelection {
  readonly agent?: SmokeAgentName
  readonly sandbox?: SmokeSandboxName
}

export type SmokeCommand =
  | { readonly kind: "help" }
  | { readonly kind: "list"; readonly selection: SmokeSelection }
  | { readonly kind: "run"; readonly selection: SmokeSelection }

export function selectSmokeCases(selection: SmokeSelection = {}): SmokeCase[] {
  const agents = selection.agent === undefined ? SMOKE_AGENT_NAMES : [selection.agent]
  const sandboxes = selection.sandbox === undefined ? SMOKE_SANDBOX_NAMES : [selection.sandbox]
  return agents.flatMap(agent => sandboxes.map(sandbox => ({ agent, sandbox })))
}

export function parseSmokeCommand(args: readonly string[]): SmokeCommand {
  let agent: SmokeAgentName | undefined
  let sandbox: SmokeSandboxName | undefined
  let help = false
  let list = false

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]

    if (argument === "--help" || argument === "-h") {
      help = true
      continue
    }

    if (argument === "--list") {
      list = true
      continue
    }

    if (argument === "--agent") {
      const value = args[++index]
      if (value === undefined) throw new TypeError("--agent requires a value")
      if (!SMOKE_AGENT_NAMES.includes(value as SmokeAgentName)) {
        throw new TypeError(`Unknown smoke Agent "${value}". Available: ${SMOKE_AGENT_NAMES.join(", ")}`)
      }
      agent = value as SmokeAgentName
      continue
    }

    if (argument === "--sandbox") {
      const value = args[++index]
      if (value === undefined) throw new TypeError("--sandbox requires a value")
      if (!SMOKE_SANDBOX_NAMES.includes(value as SmokeSandboxName)) {
        throw new TypeError(`Unknown smoke Sandbox "${value}". Available: ${SMOKE_SANDBOX_NAMES.join(", ")}`)
      }
      sandbox = value as SmokeSandboxName
      continue
    }

    throw new TypeError(`Unknown smoke argument "${argument}"`)
  }

  if (help) return { kind: "help" }
  const selection = {
    ...(agent === undefined ? {} : { agent }),
    ...(sandbox === undefined ? {} : { sandbox }),
  }
  return list ? { kind: "list", selection } : { kind: "run", selection }
}

/**
 * Parses the independently runnable kitchen-sink application selection.
 */
export function parseKitchenSinkCommand(args: readonly string[]): KitchenSinkCommand {
  let agent = DEFAULT_KITCHEN_SINK_SELECTION.agent
  let mcp = DEFAULT_KITCHEN_SINK_SELECTION.mcp
  let sandbox = DEFAULT_KITCHEN_SINK_SELECTION.sandbox
  let workspace = DEFAULT_KITCHEN_SINK_SELECTION.workspace

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]

    if (argument === "--help" || argument === "-h") return { kind: "help" }

    const value = args[++index]
    if (value === undefined) throw new TypeError(`${argument} requires a value`)

    if (argument === "--agent") {
      if (!SMOKE_AGENT_NAMES.includes(value as SmokeAgentName)) {
        throw new TypeError(`Unknown kitchen-sink Agent "${value}". Available: ${SMOKE_AGENT_NAMES.join(", ")}`)
      }
      agent = value as SmokeAgentName
      continue
    }

    if (argument === "--sandbox") {
      if (!SMOKE_SANDBOX_NAMES.includes(value as SmokeSandboxName)) {
        throw new TypeError(`Unknown kitchen-sink Sandbox "${value}". Available: ${SMOKE_SANDBOX_NAMES.join(", ")}`)
      }
      sandbox = value as SmokeSandboxName
      continue
    }

    if (argument === "--workspace") {
      if (!KITCHEN_SINK_WORKSPACE_NAMES.includes(value as KitchenSinkWorkspaceName)) {
        throw new TypeError(
          `Unknown kitchen-sink Workspace "${value}". Available: ${KITCHEN_SINK_WORKSPACE_NAMES.join(", ")}`
        )
      }
      workspace = value as KitchenSinkWorkspaceName
      continue
    }

    if (argument === "--mcp") {
      if (!KITCHEN_SINK_MCP_NAMES.includes(value as KitchenSinkMcpName)) {
        throw new TypeError(`Unknown kitchen-sink MCP "${value}". Available: ${KITCHEN_SINK_MCP_NAMES.join(", ")}`)
      }
      mcp = value as KitchenSinkMcpName
      continue
    }

    throw new TypeError(`Unknown kitchen-sink argument "${argument}"`)
  }

  return {
    kind: "run",
    selection: { agent, mcp, sandbox, workspace },
  }
}

function requiredOpenAiApiKey(agent: string): string {
  const apiKey = process.env.AML_CODEX_API_KEY ?? process.env.OPENAI_API_KEY
  if (apiKey === undefined) throw new Error(`${agent} smoke requires AML_CODEX_API_KEY or OPENAI_API_KEY`)
  return apiKey
}

function requiredZaiApiKey(): string {
  const apiKey = process.env.AML_ZAI_API_KEY ?? process.env.Z_AI_API_KEY
  if (apiKey === undefined) throw new Error("GLM smoke requires AML_ZAI_API_KEY or Z_AI_API_KEY")
  return apiKey
}

export function requiredCopilotGithubToken(environment: Readonly<NodeJS.ProcessEnv> = process.env): string {
  const githubToken =
    environment.AML_COPILOT_GITHUB_TOKEN ??
    environment.COPILOT_GITHUB_TOKEN ??
    environment.GH_TOKEN ??
    environment.GITHUB_TOKEN

  if (githubToken === undefined) {
    throw new Error(
      "Copilot smoke requires COPILOT_GITHUB_TOKEN, GH_TOKEN, or GITHUB_TOKEN; AML_COPILOT_GITHUB_TOKEN may override them"
    )
  }

  return githubToken
}
