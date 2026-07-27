import type { AgentProvider } from "./agent-provider.js"
import { validateAgentProvider } from "./validate-agent-provider.js"

/**
 * Finalizes one provider implementation as an immutable AML adapter.
 *
 * Names must already be normalized so the returned runtime value keeps the
 * implementation's exact inferred TypeScript type.
 */
export function defineAgentProvider<const Provider extends AgentProvider>(
  implementation: Provider,
): Readonly<Provider> {
  validateAgentProvider(implementation)
  return Object.freeze(implementation)
}
