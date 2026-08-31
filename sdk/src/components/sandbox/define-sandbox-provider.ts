import type { SandboxProvider } from "./sandbox-provider.js"
import { validateSandboxProvider } from "./validate-sandbox-provider.js"

/**
 * Finalizes one Sandbox implementation as an immutable AML adapter.
 *
 * This definition step validates the provider name and `acquire` function, then
 * shallow-freezes the original object. It performs no acquisition, proves no
 * isolation property, and does not freeze provider-owned nested state.
 */
export function defineSandboxProvider<const Provider extends SandboxProvider>(
  implementation: Provider
): Readonly<Provider> {
  validateSandboxProvider(implementation)
  return Object.freeze(implementation)
}
