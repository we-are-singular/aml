import { AmlNode, type AmlRenderable } from "../../core/aml-node.js"
import type { AgentProvider } from "./agent-provider.js"

/**
 * Provider selection, prompt children, and optional Agent-level overrides.
 */
export interface AgentProps {
  readonly children?: AmlRenderable
  readonly cwd?: string
  readonly model?: string
  readonly provider?: AgentProvider
  readonly system?: string
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
