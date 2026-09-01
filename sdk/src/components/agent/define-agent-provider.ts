import type { AgentProvider } from "./agent-provider.js"
import { validateAgentProvider } from "./validate-agent-provider.js"

/**
 * Finalizes one provider implementation as an immutable AML adapter.
 *
 * Names must already be normalized so the returned runtime value keeps the
 * implementation's exact inferred TypeScript type. AML validates `name`, `run`,
 * optional native Skill discovery, and optional `supportsSandbox`, then
 * shallow-freezes the original object; provider-owned nested state is not
 * cloned or frozen.
 */
export function defineAgentProvider<const Provider extends AgentProvider>(
  implementation: Provider
): Readonly<Provider> {
  validateAgentProvider(implementation)
  return Object.freeze(implementation)
}
