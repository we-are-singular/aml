import type { AgentProvider } from "./agent-provider.js"

/**
 * Captured provider members used without rereading mutable public properties.
 */
export interface ValidatedAgentProvider {
  readonly name: string
  readonly provider: AgentProvider
  readonly run: AgentProvider["run"]
  readonly skillDiscovery: AgentProvider["skillDiscovery"]
  readonly supportsSandbox: AgentProvider["supportsSandbox"]
}

/**
 * Validates a provider once and captures the exact members an invocation uses.
 */
export function validateAgentProvider(value: unknown): Readonly<ValidatedAgentProvider> {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Agent provider must be an object")
  }

  const candidate = value as {
    readonly name?: unknown
    readonly run?: unknown
    readonly skillDiscovery?: unknown
    readonly supportsSandbox?: unknown
  }
  const name = candidate.name
  const run = candidate.run
  const skillDiscovery = candidate.skillDiscovery
  const supportsSandbox = candidate.supportsSandbox

  if (typeof name !== "string" || name.length === 0) {
    throw new TypeError("Agent provider name must be a non-empty string")
  }

  if (name !== name.trim()) {
    throw new TypeError("Agent provider name must already be normalized")
  }

  if (typeof run !== "function") {
    throw new TypeError("Agent provider run must be a function")
  }

  if (skillDiscovery !== undefined && skillDiscovery !== "native") {
    throw new TypeError('Agent provider skillDiscovery must be "native" when provided')
  }

  if (supportsSandbox !== undefined && typeof supportsSandbox !== "function") {
    throw new TypeError("Agent provider supportsSandbox must be a function when provided")
  }

  return Object.freeze({
    name,
    provider: value as AgentProvider,
    run: run as AgentProvider["run"],
    skillDiscovery: skillDiscovery as AgentProvider["skillDiscovery"],
    supportsSandbox: supportsSandbox as AgentProvider["supportsSandbox"],
  })
}
