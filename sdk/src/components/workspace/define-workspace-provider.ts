import type { WorkspaceProvider } from "./workspace-provider.js"
import { validateWorkspaceProvider } from "./validate-workspace-provider.js"

/**
 * Validates and freezes one structurally implementable Workspace provider.
 */
export function defineWorkspaceProvider<Handle>(
  provider: WorkspaceProvider<Handle>
): Readonly<WorkspaceProvider<Handle>> {
  validateWorkspaceProvider(provider)
  return Object.freeze(provider)
}
