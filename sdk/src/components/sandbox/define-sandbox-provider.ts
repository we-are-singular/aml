import type { SandboxProvider } from "./sandbox-provider.js"
import { validateSandboxProvider } from "./validate-sandbox-provider.js"

/**
 * Finalizes one Sandbox implementation as an immutable AML adapter.
 *
 * This definition step performs no acquisition or provider-specific setup.
 */
export function defineSandboxProvider<const Provider extends SandboxProvider>(
  implementation: Provider
): Readonly<Provider> {
  validateSandboxProvider(implementation)
  return Object.freeze(implementation)
}
