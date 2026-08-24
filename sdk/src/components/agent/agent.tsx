import { AmlNode, type AmlRenderable } from "../../core/aml-node.js"
import type { AmlModelSchema } from "./aml-model-schema.js"
import type { AgentProvider } from "./agent-provider.js"

/**
 * Native coding capabilities requested from an Agent harness.
 *
 * These settings configure the harness; an enclosing Sandbox remains the
 * authoritative confinement boundary.
 */
export interface AgentPermissions {
  readonly filesystem: "read-only" | "read-write"
  readonly network: boolean
  readonly shell: boolean
}

/** Optional overrides for AML's optimistic native-capability defaults. */
export type AgentPermissionOverrides = Partial<AgentPermissions>

/**
 * Provider selection, prompt children, and optional Agent-level overrides.
 */
export interface AgentProps {
  readonly children?: AmlRenderable
  readonly cwd?: string
  readonly model?: string
  readonly name?: string
  readonly permissions?: AgentPermissionOverrides
  readonly provider?: AgentProvider
  readonly schema?: AmlModelSchema<unknown, unknown>
  readonly system?: string
  readonly timeoutMs?: number
}

/**
 * Declares one provider-backed Agent session.
 *
 * AmlRuntime intercepts this boundary after constructing its JSX descriptor.
 */
export function Agent(_props: AgentProps): never {
  throw new Error("<Agent> can only be evaluated by AmlRuntime")
}

AmlNode.markPrimitive(Agent, "agent")
