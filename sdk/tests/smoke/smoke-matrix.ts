import {
  codexAgent,
  daytonaSandbox,
  dockerSandbox,
  localSandbox,
  modalSandbox,
  opencodeAgent,
  piAgent,
  type AgentProvider,
  type SandboxProvider,
} from "../../src/index.js"

export interface SmokeAgentInstance {
  readonly provider: AgentProvider
  release?(): Promise<void>
}

interface SmokeAgentRegistration {
  create(): SmokeAgentInstance
  readonly model: string
}

/**
 * Canonical Agent registry. Every Agent automatically participates in every
 * Sandbox registered below.
 */
export const SMOKE_AGENTS = {
  codex: {
    create() {
      const apiKey = process.env.AML_CODEX_API_KEY ?? process.env.OPENAI_API_KEY
      const codexHome = process.env.AML_CODEX_HOME

      if (apiKey === undefined && codexHome === undefined) {
        throw new Error("Codex smoke requires AML_CODEX_API_KEY, OPENAI_API_KEY, or an authenticated AML_CODEX_HOME")
      }

      return {
        provider: codexAgent({
          ...(apiKey === undefined ? {} : { apiKey }),
          ...(process.env.AML_CODEX_BASE_URL === undefined ? {} : { baseUrl: process.env.AML_CODEX_BASE_URL }),
          ...(codexHome === undefined ? {} : { env: { CODEX_HOME: codexHome } }),
          model: process.env.AML_CODEX_MODEL ?? (apiKey === undefined ? "gpt-5.3-codex-spark" : "gpt-5.3-codex"),
          skipGitRepoCheck: true,
        }),
      }
    },
    get model() {
      const apiKey = process.env.AML_CODEX_API_KEY ?? process.env.OPENAI_API_KEY
      return process.env.AML_CODEX_MODEL ?? (apiKey === undefined ? "gpt-5.3-codex-spark" : "gpt-5.3-codex")
    },
  },
  opencode: {
    create() {
      const apiKey = process.env.OPENCODE_API_KEY

      if (apiKey === undefined) {
        throw new Error("OpenCode smoke requires OPENCODE_API_KEY")
      }

      const provider = opencodeAgent({
        config: {
          provider: {
            "opencode-go": {
              options: { apiKey },
            },
          },
        },
        model: process.env.AML_OPENCODE_MODEL ?? "opencode-go/glm-5.1",
      })

      return {
        provider,
        async release() {
          await provider.close()
        },
      }
    },
    get model() {
      return process.env.AML_OPENCODE_MODEL ?? "opencode-go/glm-5.1"
    },
  },
  pi: {
    create() {
      const apiKey = process.env.OPENCODE_API_KEY

      if (apiKey === undefined) {
        throw new Error("Pi smoke requires OPENCODE_API_KEY")
      }

      return {
        provider: piAgent({
          model: process.env.AML_PI_MODEL ?? "opencode-go/glm-5.1",
          providers: {
            "opencode-go": { apiKey },
          },
        }),
      }
    },
    get model() {
      return process.env.AML_PI_MODEL ?? "opencode-go/glm-5.1"
    },
  },
} satisfies Record<string, SmokeAgentRegistration>

export type SmokeAgentName = keyof typeof SMOKE_AGENTS

interface SmokeSandboxRegistration {
  create(): SandboxProvider
  readonly environment: string
}

/**
 * Each cell owns its complete environment instead of deriving hidden defaults
 * from the selected Agent name.
 */
export const SMOKE_SANDBOXES = {
  daytona: {
    codex: {
      create() {
        const apiKey = process.env.DAYTONA_API_KEY

        if (apiKey === undefined) {
          throw new Error("Daytona smoke requires DAYTONA_API_KEY")
        }

        return daytonaSandbox({
          config: { apiKey },
          setup: "test -f input.txt && command -v codex",
        })
      },
      environment: "default-snapshot",
    },
    opencode: {
      create() {
        const apiKey = process.env.DAYTONA_API_KEY

        if (apiKey === undefined) {
          throw new Error("Daytona smoke requires DAYTONA_API_KEY")
        }

        return daytonaSandbox({
          config: { apiKey },
          setup: "test -f input.txt && command -v opencode",
        })
      },
      environment: "default-snapshot",
    },
    pi: {
      create() {
        const apiKey = process.env.DAYTONA_API_KEY

        if (apiKey === undefined) {
          throw new Error("Daytona smoke requires DAYTONA_API_KEY")
        }

        return daytonaSandbox({
          config: { apiKey },
          setup: "test -f input.txt",
        })
      },
      environment: "default-snapshot",
    },
  },
  docker: {
    codex: {
      create() {
        return dockerSandbox({
          image: "node:26",
          setup: "test -f input.txt && npm install --global @openai/codex@0.145.0",
        })
      },
      environment: "node:26",
    },
    opencode: {
      create() {
        return dockerSandbox({
          image: "node:26",
          setup: "test -f input.txt && npm install --global opencode-ai@1.18.7",
        })
      },
      environment: "node:26",
    },
    pi: {
      create() {
        return dockerSandbox({
          image: "alpine:3.22",
          setup: "test -f input.txt",
        })
      },
      environment: "alpine:3.22",
    },
  },
  local: {
    codex: {
      create() {
        return localSandbox({ setup: "test -f input.txt" })
      },
      environment: "host",
    },
    opencode: {
      create() {
        return localSandbox({ setup: "test -f input.txt" })
      },
      environment: "host",
    },
    pi: {
      create() {
        return localSandbox({ setup: "test -f input.txt" })
      },
      environment: "host",
    },
  },
  modal: {
    codex: {
      create() {
        const tokenId = process.env.MODAL_API_KEY
        const tokenSecret = process.env.MODAL_API_SECRET

        if (tokenId === undefined || tokenSecret === undefined) {
          throw new Error("Modal smoke requires MODAL_API_KEY and MODAL_API_SECRET")
        }

        return modalSandbox({
          appName: "aml-jsx-smoke",
          config: { tokenId, tokenSecret },
          create: { memoryMiB: 2_048, timeoutMs: 120_000 },
          image: "node:26",
          setup: "test -f input.txt && npm install --global @openai/codex@0.145.0",
        })
      },
      environment: "node:26",
    },
    opencode: {
      create() {
        const tokenId = process.env.MODAL_API_KEY
        const tokenSecret = process.env.MODAL_API_SECRET

        if (tokenId === undefined || tokenSecret === undefined) {
          throw new Error("Modal smoke requires MODAL_API_KEY and MODAL_API_SECRET")
        }

        return modalSandbox({
          appName: "aml-jsx-smoke",
          config: { tokenId, tokenSecret },
          create: { memoryMiB: 2_048, timeoutMs: 120_000 },
          image: "node:26",
          setup: "test -f input.txt && npm install --global opencode-ai@1.18.7",
        })
      },
      environment: "node:26",
    },
    pi: {
      create() {
        const tokenId = process.env.MODAL_API_KEY
        const tokenSecret = process.env.MODAL_API_SECRET

        if (tokenId === undefined || tokenSecret === undefined) {
          throw new Error("Modal smoke requires MODAL_API_KEY and MODAL_API_SECRET")
        }

        return modalSandbox({
          appName: "aml-jsx-smoke",
          config: { tokenId, tokenSecret },
          create: { timeoutMs: 120_000 },
          image: "alpine:3.22",
          setup: "test -f input.txt",
        })
      },
      environment: "alpine:3.22",
    },
  },
} satisfies Record<string, Record<SmokeAgentName, SmokeSandboxRegistration>>

export type SmokeSandboxName = keyof typeof SMOKE_SANDBOXES

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

      if (value === undefined) {
        throw new TypeError("--agent requires a value")
      }

      if (!SMOKE_AGENT_NAMES.includes(value as SmokeAgentName)) {
        throw new TypeError(`Unknown smoke Agent "${value}". Available: ${SMOKE_AGENT_NAMES.join(", ")}`)
      }

      agent = value as SmokeAgentName
      continue
    }

    if (argument === "--sandbox") {
      const value = args[++index]

      if (value === undefined) {
        throw new TypeError("--sandbox requires a value")
      }

      if (!SMOKE_SANDBOX_NAMES.includes(value as SmokeSandboxName)) {
        throw new TypeError(`Unknown smoke Sandbox "${value}". Available: ${SMOKE_SANDBOX_NAMES.join(", ")}`)
      }

      sandbox = value as SmokeSandboxName
      continue
    }

    throw new TypeError(`Unknown smoke argument "${argument}"`)
  }

  if (help) {
    return { kind: "help" }
  }

  const selection = {
    ...(agent === undefined ? {} : { agent }),
    ...(sandbox === undefined ? {} : { sandbox }),
  }

  return list ? { kind: "list", selection } : { kind: "run", selection }
}
