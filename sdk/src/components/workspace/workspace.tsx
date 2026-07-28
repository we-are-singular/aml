import { AmlNode, type AmlRenderable } from "../../core/aml-node.js"
import type { WorkspaceProvider } from "./workspace-provider.js"

/**
 * Durable identity, provider selection, and authored Workspace subtree.
 */
export interface WorkspaceProps {
  readonly children?: AmlRenderable
  readonly id: string
  readonly provider?: WorkspaceProvider
}

/**
 * Scopes one durable materialization to its descendant work.
 *
 * AML saves after both success and failure, then releases the provider lease.
 */
export function Workspace(_props: WorkspaceProps): never {
  throw new Error("<Workspace> can only be evaluated by AmlRuntime")
}

AmlNode.markPrimitive(Workspace, "workspace")
