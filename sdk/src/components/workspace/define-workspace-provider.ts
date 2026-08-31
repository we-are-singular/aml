import type { WorkspaceProvider } from "./workspace-provider.js"
import { validateWorkspaceProvider } from "./validate-workspace-provider.js"

/**
 * Validates and shallow-freezes one structurally implementable Workspace provider.
 *
 * The definition step checks the normalized provider name and `acquire` method
 * without materializing data or proving persistence, locking, or cleanup. Nested
 * provider-owned state is retained rather than cloned or deeply frozen.
 */
export function defineWorkspaceProvider<Handle>(
  provider: WorkspaceProvider<Handle>
): Readonly<WorkspaceProvider<Handle>> {
  validateWorkspaceProvider(provider)
  return Object.freeze(provider)
}
