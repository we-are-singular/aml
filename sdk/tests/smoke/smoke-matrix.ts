import {
  codexAgent,
  daytonaSandbox,
  dockerSandbox,
  localSandbox,
  opencodeAgent,
  piAgent,
  type AgentProvider,
  type SandboxProvider,
} from "../../src/index.js"

interface SmokeAgentRegistration {
  create(): AgentProvider
  readonly model: string
  release(provider: AgentProvider): Promise<void>
}

interface SmokeSandboxRegistration {
  create(agent: SmokeAgentName): SandboxProvider
  environment(agent: SmokeAgentName): string
}

/**
 * Canonical Agent registry. Every registered Agent automatically participates
 * in every registered Sandbox cell.
 */
const SMOKE_AGENTS = {
  codex: {
    create() {
      return codexAgent({
        ...(process.env.OPENAI_API_KEY === undefined ? {} : { apiKey: process.env.OPENAI_API_KEY }),
        model: process.env.AML_CODEX_MODEL ?? "gpt-5.3-codex-spark",
      })
    },
    model: process.env.AML_CODEX_MODEL ?? "gpt-5.3-codex-spark",
    async release() {},
  },
  opencode: {
    create() {
      return opencodeAgent({
        model: process.env.AML_OPENCODE_MODEL ?? "opencode-go/glm-5.1",
        server: { port: 0, timeout: 15_000 },
      })
    },
    model: process.env.AML_OPENCODE_MODEL ?? "opencode-go/glm-5.1",
    async release(provider) {
      if ("close" in provider && typeof provider.close === "function") {
        await provider.close()
      }
    },
  },
  pi: {
    create() {
      const apiKey = requiredEnvironment("OPENCODE_API_KEY", "Pi smoke")

      return piAgent({
        model: process.env.AML_PI_MODEL ?? "opencode-go/glm-5.1",
        providers: {
          "opencode-go": { apiKey },
        },
      })
    },
    model: process.env.AML_PI_MODEL ?? "opencode-go/glm-5.1",
    async release() {},
  },
} satisfies Record<string, SmokeAgentRegistration>

export type SmokeAgentName = keyof typeof SMOKE_AGENTS

/**
 * Canonical Sandbox registry. Factories remain provider-specific while the
 * matrix owns only selection and common proof execution.
 */
const SMOKE_SANDBOXES = {
  daytona: {
    create(agent) {
      const apiKey = requiredEnvironment("DAYTONA_API_KEY", "Daytona smoke")
      const image = sandboxEnvironment("DAYTONA", agent, "IMAGE")
      const snapshot = sandboxEnvironment("DAYTONA", agent, "SNAPSHOT")

      if (image !== undefined && snapshot !== undefined) {
        throw new TypeError(`Daytona smoke for ${agent} accepts an image or snapshot, not both`)
      }

      return daytonaSandbox({
        config: { apiKey },
        ...(image === undefined ? {} : { create: { image } }),
        ...(snapshot === undefined ? {} : { create: { snapshot } }),
        setup: sandboxSetup("DAYTONA", agent),
      })
    },
    environment(agent) {
      return (
        sandboxEnvironment("DAYTONA", agent, "SNAPSHOT") ??
        sandboxEnvironment("DAYTONA", agent, "IMAGE") ??
        "default-snapshot"
      )
    },
  },
  docker: {
    create(agent) {
      return dockerSandbox({
        image: dockerImage(agent),
        setup: sandboxSetup("DOCKER", agent),
      })
    },
    environment: dockerImage,
  },
  local: {
    create(agent) {
      return localSandbox({
        setup: sandboxSetup("LOCAL", agent),
      })
    },
    environment() {
      return "host"
    },
  },
} satisfies Record<string, SmokeSandboxRegistration>

export type SmokeSandboxName = keyof typeof SMOKE_SANDBOXES

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

/**
 * Computes the selected Cartesian product directly from both registries.
 */
export function selectSmokeCases(selection: SmokeSelection = {}): readonly Readonly<SmokeCase>[] {
  const agents = selection.agent === undefined ? smokeAgentNames() : [selection.agent]
  const sandboxes = selection.sandbox === undefined ? smokeSandboxNames() : [selection.sandbox]

  return Object.freeze(agents.flatMap(agent => sandboxes.map(sandbox => Object.freeze({ agent, sandbox }))))
}

export function smokeAgentNames(): readonly SmokeAgentName[] {
  return Object.freeze(Object.keys(SMOKE_AGENTS).sort() as SmokeAgentName[])
}

export function smokeSandboxNames(): readonly SmokeSandboxName[] {
  return Object.freeze(Object.keys(SMOKE_SANDBOXES).sort() as SmokeSandboxName[])
}

export function smokeAgent(name: SmokeAgentName): SmokeAgentRegistration {
  return SMOKE_AGENTS[name]
}

export function smokeSandbox(name: SmokeSandboxName): SmokeSandboxRegistration {
  return SMOKE_SANDBOXES[name]
}

/**
 * Parses the small smoke CLI without leaking its flags into Vitest.
 */
export function parseSmokeCommand(args: readonly string[]): Readonly<SmokeCommand> {
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

    if (argument === "--agent" || argument?.startsWith("--agent=")) {
      if (agent !== undefined) {
        throw new TypeError("Smoke --agent may be provided only once")
      }

      const value = optionValue(argument, args[index + 1], "--agent")
      index += argument === "--agent" ? 1 : 0
      agent = parseAgentName(value)
      continue
    }

    if (argument === "--sandbox" || argument?.startsWith("--sandbox=")) {
      if (sandbox !== undefined) {
        throw new TypeError("Smoke --sandbox may be provided only once")
      }

      const value = optionValue(argument, args[index + 1], "--sandbox")
      index += argument === "--sandbox" ? 1 : 0
      sandbox = parseSandboxName(value)
      continue
    }

    throw new TypeError(`Unknown smoke argument "${argument ?? ""}"`)
  }

  if (help) {
    return Object.freeze({ kind: "help" })
  }

  const selection = Object.freeze({
    ...(agent === undefined ? {} : { agent }),
    ...(sandbox === undefined ? {} : { sandbox }),
  })

  return Object.freeze(list ? { kind: "list", selection } : { kind: "run", selection })
}

export function smokeHelp(): string {
  return [
    "Usage: npm run smoke -- [--agent <name>] [--sandbox <name>] [--list]",
    "",
    `Agents: ${smokeAgentNames().join(", ")}`,
    `Sandboxes: ${smokeSandboxNames().join(", ")}`,
    "",
    "Omitted filters run the complete Agent x Sandbox matrix.",
  ].join("\n")
}

function optionValue(argument: string, next: string | undefined, option: string): string {
  const equals = argument.indexOf("=")
  const value = equals === -1 ? next : argument.slice(equals + 1)

  if (value === undefined || value.length === 0 || value.startsWith("--")) {
    throw new TypeError(`${option} requires a value`)
  }

  return value
}

function parseAgentName(value: string): SmokeAgentName {
  if (!smokeAgentNames().includes(value as SmokeAgentName)) {
    throw new TypeError(`Unknown smoke Agent "${value}". Available: ${smokeAgentNames().join(", ")}`)
  }

  return value as SmokeAgentName
}

function parseSandboxName(value: string): SmokeSandboxName {
  if (!smokeSandboxNames().includes(value as SmokeSandboxName)) {
    throw new TypeError(`Unknown smoke Sandbox "${value}". Available: ${smokeSandboxNames().join(", ")}`)
  }

  return value as SmokeSandboxName
}

function dockerImage(agent: SmokeAgentName): string {
  return sandboxEnvironment("DOCKER", agent, "IMAGE") ?? "alpine:3.22"
}

function sandboxSetup(provider: string, agent: SmokeAgentName): string {
  const configured = sandboxEnvironment(provider, agent, "SETUP")
  return configured === undefined ? "test -f input.txt" : `test -f input.txt && (${configured})`
}

function sandboxEnvironment(provider: string, agent: SmokeAgentName, suffix: string): string | undefined {
  return process.env[`AML_${provider}_${agent.toUpperCase()}_${suffix}`] ?? process.env[`AML_${provider}_${suffix}`]
}

function requiredEnvironment(name: string, label: string): string {
  const value = process.env[name]

  if (value === undefined || value.length === 0) {
    throw new Error(`${label} requires ${name}`)
  }

  return value
}
